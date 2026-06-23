// Content_Bundle validator (task 2.2).
//
// Pipeline:
//   1. Read the four top-level authored files (manifest.json, route.json,
//      pois.json, optionally per-track standby/{trackId}.json) and parse
//      them as JSON. Parse errors are reported with the offending file
//      path and a `parse-error` hint.
//   2. Run JSON Schema 2020-12 validation (Ajv) against every file kind.
//      Any violation aborts cross-file checks for that file (we still
//      keep going on sibling files so authors get as many errors as
//      possible in one pass).
//   3. Walk every narrative reference in pois.json (POIs + deeperLayers)
//      and standby tracks; load the referenced markdown, parse the
//      frontmatter, and run the narrative-frontmatter schema on the
//      parsed object. Missing files become `missing-file` errors.
//   4. Enforce the cross-file invariants enumerated in the task:
//        - Every key in `Poi.audio` and `StandbyTrack.audio` is present
//          in the corresponding `narratives` map (Req 16.3).
//        - Every audio file referenced exists on disk.
//        - Every B2B narrative carries `sponsor` AND `disclosure` (the
//          schema covers self-declared `tier: b2b`; this layer also
//          enforces the parent-POI-tier-cascades-to-narrative case).
//        - Every CC license entry on a narrative has non-empty `id`
//          AND `attribution` (the schema covers it; this layer keeps
//          the check defensible after future schema relaxations).
//        - `manifest.languages` includes `manifest.defaultLanguage` and
//          every POI has a narrative entry for `defaultLanguage`.
//        - Stop GTFS ids unique within a route, POI ids unique within
//          pois.json, standby-track ids unique within
//          `manifest.standbyTracks`, every standby-track id has a
//          corresponding `standby/{id}.json` on disk.

import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';

import {
  AUTHORING_SCHEMAS,
  type AuthoringSchemaEntry,
} from '../schemas/authoring';
import type {
  EntitlementTier,
  Manifest,
  NarrativeFrontmatter,
  Poi,
  Pois,
  Route,
  StandbyTrack,
} from '../types';

import type { BundleFileSystem } from './fs';
import { parseFrontmatter } from './frontmatter';
import { ajvInstancePathToPointer, pointerFromSegments } from './jsonPointer';
import type {
  BundleValidationError,
  Hint,
  HintCode,
  LoadedBundle,
  LoadedNarrative,
  ValidationResult,
} from './types';

// ---------------------------------------------------------------------------
// Hint helpers
// ---------------------------------------------------------------------------

function hint(code: HintCode, text: string): Hint {
  return { code, text };
}

function err(
  filePath: string,
  jsonPointer: string,
  message: string,
  hintValue: Hint,
): BundleValidationError {
  return { filePath, jsonPointer, message, hint: hintValue };
}

// ---------------------------------------------------------------------------
// Compiled-validator cache
// ---------------------------------------------------------------------------

interface CompiledValidators {
  readonly manifest: ValidateFunction;
  readonly route: ValidateFunction;
  readonly pois: ValidateFunction;
  readonly narrativeFrontmatter: ValidateFunction;
  readonly standbyTrack: ValidateFunction;
}

function compileValidators(): CompiledValidators {
  // strict:false because the schemas use free-form `description`/`title`
  // metadata. allErrors so we surface every constraint violation in a
  // single pass — authors get a complete diagnostic report instead of a
  // drip-feed.
  const ajv = new Ajv2020({ strict: false, allErrors: true });

  const compile = (entry: AuthoringSchemaEntry): ValidateFunction =>
    ajv.compile(entry.schema as unknown as object);

  return {
    manifest: compile(AUTHORING_SCHEMAS.manifest),
    route: compile(AUTHORING_SCHEMAS.route),
    pois: compile(AUTHORING_SCHEMAS.pois),
    narrativeFrontmatter: compile(AUTHORING_SCHEMAS['narrative-frontmatter']),
    standbyTrack: compile(AUTHORING_SCHEMAS['standby-track']),
  };
}

let cachedValidators: CompiledValidators | undefined;
function getValidators(): CompiledValidators {
  if (cachedValidators === undefined) cachedValidators = compileValidators();
  return cachedValidators;
}

function describeAjvError(e: ErrorObject): string {
  const where = e.instancePath.length > 0 ? `${e.instancePath} ` : '';
  return `${where}${e.message ?? 'invalid'}`.trim();
}

function ajvErrorsToValidation(
  filePath: string,
  errors: readonly ErrorObject[] | null | undefined,
): BundleValidationError[] {
  if (!errors || errors.length === 0) return [];
  return errors.map((e) =>
    err(
      filePath,
      ajvInstancePathToPointer(e.instancePath),
      describeAjvError(e),
      hint('schema-violation', `Field does not satisfy ${filePath}'s JSON Schema.`),
    ),
  );
}

// ---------------------------------------------------------------------------
// Top-level entry
// ---------------------------------------------------------------------------

/**
 * Validate a Content_Bundle exposed via a `BundleFileSystem`. Returns a
 * discriminated `ValidationResult`. Pure, synchronous, no I/O outside
 * the abstraction.
 */
export function validateBundle(fsAdapter: BundleFileSystem): ValidationResult {
  const errors: BundleValidationError[] = [];

  // ---------------------------------------------------------------------
  // 1. Parse + schema-validate the four authored entry-point files.
  // ---------------------------------------------------------------------

  const manifest = readAndValidateJson<Manifest>(
    fsAdapter,
    'manifest.json',
    'manifest',
    errors,
  );
  const route = readAndValidateJson<Route>(fsAdapter, 'route.json', 'route', errors);
  const pois = readAndValidateJson<Pois>(fsAdapter, 'pois.json', 'pois', errors);

  // If any of the three top-level files failed to parse OR was missing
  // entirely, we cannot meaningfully run cross-file invariants. Bail
  // here; any schema violations on individual files have already been
  // recorded.
  if (manifest === undefined || route === undefined || pois === undefined) {
    return { ok: false, errors };
  }

  // ---------------------------------------------------------------------
  // 2. Cross-file invariants on manifest.
  // ---------------------------------------------------------------------

  // (6a) `manifest.languages` must include `manifest.defaultLanguage`.
  if (!manifest.languages.includes(manifest.defaultLanguage)) {
    errors.push(
      err(
        'manifest.json',
        '/defaultLanguage',
        `defaultLanguage "${manifest.defaultLanguage}" is not present in languages [${manifest.languages.join(', ')}].`,
        hint(
          'default-language-missing-from-languages',
          'Add the default language to `languages`, or change `defaultLanguage` to a language already declared.',
        ),
      ),
    );
  }

  // (7a) Standby-track ids are unique within the manifest.
  reportDuplicates(
    manifest.standbyTracks,
    (id, index) =>
      err(
        'manifest.json',
        pointerFromSegments(['standbyTracks', index]),
        `Standby track id "${id}" is declared more than once in manifest.standbyTracks.`,
        hint('duplicate-id', 'Remove the duplicate entry or rename one of the tracks.'),
      ),
    errors,
  );

  // ---------------------------------------------------------------------
  // 3. Cross-file invariants on route.
  // ---------------------------------------------------------------------

  // (7a-route) Stop GTFS ids must be unique within the route.
  const stopGtfsIds = route.stops.map((s) => s.gtfsStopId);
  reportDuplicates(
    stopGtfsIds,
    (id, index) =>
      err(
        'route.json',
        pointerFromSegments(['stops', index, 'gtfsStopId']),
        `GTFS stop id "${id}" appears on multiple stops in this route.`,
        hint('duplicate-id', 'Each stop must reference a distinct GTFS stop id.'),
      ),
    errors,
  );

  // ---------------------------------------------------------------------
  // 4. Cross-file invariants on POIs (ids, narratives, audio, deeper layers).
  // ---------------------------------------------------------------------

  // (7a-pois) POI ids must be unique within pois.json.
  const poiIds = pois.pois.map((p) => p.id);
  reportDuplicates(
    poiIds,
    (id, index) =>
      err(
        'pois.json',
        pointerFromSegments(['pois', index, 'id']),
        `POI id "${id}" appears more than once in pois.json.`,
        hint('duplicate-id', 'Rename one of the duplicates so each POI has a unique id.'),
      ),
    errors,
  );

  // Narratives map: keyed by bundle-relative path.
  const narratives = new Map<string, LoadedNarrative>();
  // Audio assets confirmed on disk.
  const confirmedAudioFiles = new Set<string>();

  for (let i = 0; i < pois.pois.length; i += 1) {
    const poi = pois.pois[i]!;
    validatePoiCrossFile(
      poi,
      i,
      manifest,
      fsAdapter,
      narratives,
      confirmedAudioFiles,
      errors,
    );
  }

  // ---------------------------------------------------------------------
  // 5. Standby tracks.
  // ---------------------------------------------------------------------

  const standbyTracks = new Map<string, StandbyTrack>();
  for (let i = 0; i < manifest.standbyTracks.length; i += 1) {
    const id = manifest.standbyTracks[i]!;
    validateStandbyTrack(
      id,
      i,
      fsAdapter,
      narratives,
      confirmedAudioFiles,
      standbyTracks,
      errors,
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  // ---------------------------------------------------------------------
  // 6. Build the LoadedBundle.
  // ---------------------------------------------------------------------
  const bundle: LoadedBundle = {
    manifest,
    route,
    pois,
    narratives,
    standbyTracks,
    audioFiles: confirmedAudioFiles,
  };
  return { ok: true, bundle };
}

// ---------------------------------------------------------------------------
// File reading + JSON Schema validation for top-level entry-point files.
// ---------------------------------------------------------------------------

function readAndValidateJson<T>(
  fsAdapter: BundleFileSystem,
  relativePath: string,
  kind: keyof typeof AUTHORING_SCHEMAS,
  errors: BundleValidationError[],
): T | undefined {
  const read = fsAdapter.readFile(relativePath);
  if (!read.exists) {
    errors.push(
      err(
        relativePath,
        '',
        `Required file "${relativePath}" is missing from the bundle.`,
        hint('missing-file', `Author the file at the bundle root.`),
      ),
    );
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content.toString('utf8'));
  } catch (e) {
    errors.push(
      err(
        relativePath,
        '',
        `Failed to parse JSON: ${(e as Error).message}`,
        hint('parse-error', 'Fix the JSON syntax error before re-running validation.'),
      ),
    );
    return undefined;
  }

  const validator = getValidators()[
    kind === 'narrative-frontmatter'
      ? 'narrativeFrontmatter'
      : kind === 'standby-track'
        ? 'standbyTrack'
        : kind
  ];

  const isValid = validator(parsed);
  if (!isValid) {
    errors.push(...ajvErrorsToValidation(relativePath, validator.errors));
    return undefined;
  }
  return parsed as T;
}

// ---------------------------------------------------------------------------
// Per-POI cross-file validation
// ---------------------------------------------------------------------------

function validatePoiCrossFile(
  poi: Poi,
  poiIndex: number,
  manifest: Manifest,
  fsAdapter: BundleFileSystem,
  narratives: Map<string, LoadedNarrative>,
  confirmedAudioFiles: Set<string>,
  errors: BundleValidationError[],
): void {
  // (6b) Every POI must have a narrative entry for the manifest's
  // defaultLanguage.
  if (!Object.prototype.hasOwnProperty.call(poi.narratives, manifest.defaultLanguage)) {
    errors.push(
      err(
        'pois.json',
        pointerFromSegments(['pois', poiIndex, 'narratives']),
        `POI "${poi.id}" has no narrative entry for the bundle's default language "${manifest.defaultLanguage}".`,
        hint(
          'default-language-narrative-missing',
          'Add a narrative reference under the default language key.',
        ),
      ),
    );
  }

  // (1) Every key in `Poi.audio` exists in `Poi.narratives` (transcript pair).
  if (poi.audio !== undefined) {
    const audioMap = poi.audio;
    for (const lang of Object.keys(audioMap)) {
      if (!Object.prototype.hasOwnProperty.call(poi.narratives, lang)) {
        errors.push(
          err(
            'pois.json',
            pointerFromSegments(['pois', poiIndex, 'audio', lang]),
            `POI "${poi.id}" declares pre-rendered audio for language "${lang}" but no transcript narrative is provided in that language.`,
            hint(
              'transcript-missing',
              'Pre-rendered audio requires a transcript Markdown in the same language (Requirement 16.3).',
            ),
          ),
        );
      }
    }
  }

  // (2) Every narrative file referenced exists on disk and validates.
  for (const [lang, narrativePath] of Object.entries(poi.narratives)) {
    loadAndValidateNarrative({
      narrativePath,
      ownerFilePath: 'pois.json',
      ownerJsonPointer: pointerFromSegments(['pois', poiIndex, 'narratives', lang]),
      poiId: poi.id,
      language: lang,
      parentTier: poi.tier,
      fsAdapter,
      narratives,
      errors,
    });
  }

  // (4) deeperLayers narratives exist on disk and validate.
  if (poi.deeperLayers !== undefined) {
    for (let li = 0; li < poi.deeperLayers.length; li += 1) {
      const layer = poi.deeperLayers[li]!;
      loadAndValidateNarrative({
        narrativePath: layer.narrative,
        ownerFilePath: 'pois.json',
        ownerJsonPointer: pointerFromSegments([
          'pois',
          poiIndex,
          'deeperLayers',
          li,
          'narrative',
        ]),
        poiId: poi.id,
        // Deeper-layer narratives may not declare their own `language`
        // field that matches a particular code; we skip the language
        // sanity check by passing `undefined`.
        language: undefined,
        parentTier: layer.tier,
        fsAdapter,
        narratives,
        errors,
      });
    }
  }

  // (3) Every audio file referenced exists on disk.
  if (poi.audio !== undefined) {
    for (const [lang, audioPath] of Object.entries(poi.audio)) {
      // Skip the existence check if the transcript-pair invariant
      // already failed for this language; reporting two errors for the
      // same key only adds noise.
      if (!Object.prototype.hasOwnProperty.call(poi.narratives, lang)) continue;
      if (!fsAdapter.exists(audioPath)) {
        errors.push(
          err(
            'pois.json',
            pointerFromSegments(['pois', poiIndex, 'audio', lang]),
            `POI "${poi.id}" references audio asset "${audioPath}" for language "${lang}" but the file is missing from the bundle.`,
            hint(
              'missing-file',
              `Add the audio file at "${audioPath}" or remove the reference.`,
            ),
          ),
        );
      } else {
        confirmedAudioFiles.add(audioPath);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Standby track validation
// ---------------------------------------------------------------------------

function validateStandbyTrack(
  trackId: string,
  manifestIndex: number,
  fsAdapter: BundleFileSystem,
  narratives: Map<string, LoadedNarrative>,
  confirmedAudioFiles: Set<string>,
  standbyTracks: Map<string, StandbyTrack>,
  errors: BundleValidationError[],
): void {
  const trackPath = `standby/${trackId}.json`;

  // (7b) Every standby track id has a corresponding standby/{id}.json on disk.
  const read = fsAdapter.readFile(trackPath);
  if (!read.exists) {
    errors.push(
      err(
        'manifest.json',
        pointerFromSegments(['standbyTracks', manifestIndex]),
        `Standby track "${trackId}" declared in manifest.standbyTracks has no corresponding "${trackPath}" file.`,
        hint(
          'standby-file-missing',
          `Author "${trackPath}" or remove the entry from manifest.standbyTracks.`,
        ),
      ),
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content.toString('utf8'));
  } catch (e) {
    errors.push(
      err(
        trackPath,
        '',
        `Failed to parse JSON: ${(e as Error).message}`,
        hint('parse-error', 'Fix the JSON syntax error before re-running validation.'),
      ),
    );
    return;
  }

  const validator = getValidators().standbyTrack;
  if (!validator(parsed)) {
    errors.push(...ajvErrorsToValidation(trackPath, validator.errors));
    return;
  }

  const track = parsed as StandbyTrack;

  // The `id` declared inside the standby JSON must match the manifest entry.
  if (track.id !== trackId) {
    errors.push(
      err(
        trackPath,
        '/id',
        `Standby track id "${track.id}" inside ${trackPath} does not match the manifest declaration "${trackId}".`,
        hint('duplicate-id', 'Rename the file or update the `id` field to match.'),
      ),
    );
  }

  // (1) Every key in StandbyTrack.audio exists in StandbyTrack.narratives.
  if (track.audio !== undefined) {
    const audio = track.audio;
    for (const lang of Object.keys(audio)) {
      if (!Object.prototype.hasOwnProperty.call(track.narratives, lang)) {
        errors.push(
          err(
            trackPath,
            pointerFromSegments(['audio', lang]),
            `Standby track "${trackId}" declares pre-rendered audio for language "${lang}" but no transcript narrative is provided in that language.`,
            hint(
              'transcript-missing',
              'Pre-rendered audio requires a transcript Markdown in the same language (Requirement 16.3).',
            ),
          ),
        );
      }
    }
  }

  // (2) Every narrative file referenced exists on disk and validates.
  for (const [lang, narrativePath] of Object.entries(track.narratives)) {
    loadAndValidateNarrative({
      narrativePath,
      ownerFilePath: trackPath,
      ownerJsonPointer: pointerFromSegments(['narratives', lang]),
      // Standby tracks are not POIs but the frontmatter parser still
      // expects a `poiId`; we use the track id as a stand-in for error
      // messages (the schema check on the frontmatter is independent).
      poiId: trackId,
      language: lang,
      parentTier: track.tier,
      fsAdapter,
      narratives,
      errors,
    });
  }

  // (3) Every audio file referenced exists on disk.
  if (track.audio !== undefined) {
    for (const [lang, audioPath] of Object.entries(track.audio)) {
      if (!Object.prototype.hasOwnProperty.call(track.narratives, lang)) continue;
      if (!fsAdapter.exists(audioPath)) {
        errors.push(
          err(
            trackPath,
            pointerFromSegments(['audio', lang]),
            `Standby track "${trackId}" references audio asset "${audioPath}" for language "${lang}" but the file is missing from the bundle.`,
            hint(
              'missing-file',
              `Add the audio file at "${audioPath}" or remove the reference.`,
            ),
          ),
        );
      } else {
        confirmedAudioFiles.add(audioPath);
      }
    }
  }

  standbyTracks.set(trackId, track);
}

// ---------------------------------------------------------------------------
// Narrative loading + per-narrative invariants
// ---------------------------------------------------------------------------

interface NarrativeLoadArgs {
  readonly narrativePath: string;
  readonly ownerFilePath: string;
  readonly ownerJsonPointer: string;
  readonly poiId: string;
  /**
   * Authoring language declared at the reference site (the key in
   * `narratives`). `undefined` for deeperLayers, where no language key
   * is present at the reference site.
   */
  readonly language: string | undefined;
  /** Tier carried by the parent POI / deeper-layer / standby track. */
  readonly parentTier: EntitlementTier;
  readonly fsAdapter: BundleFileSystem;
  readonly narratives: Map<string, LoadedNarrative>;
  readonly errors: BundleValidationError[];
}

function loadAndValidateNarrative(args: NarrativeLoadArgs): void {
  const {
    narrativePath,
    ownerFilePath,
    ownerJsonPointer,
    poiId,
    language,
    parentTier,
    fsAdapter,
    narratives,
    errors,
  } = args;

  // Memoise: the same narrative file may be referenced from multiple
  // places (it shouldn't, but the validator should not double-load).
  if (narratives.has(narrativePath)) return;

  const read = fsAdapter.readFile(narrativePath);
  if (!read.exists) {
    errors.push(
      err(
        ownerFilePath,
        ownerJsonPointer,
        `Narrative file "${narrativePath}" referenced by POI/track "${poiId}" is missing from the bundle.`,
        hint(
          'missing-file',
          `Author the narrative at "${narrativePath}" or update the reference.`,
        ),
      ),
    );
    return;
  }

  const source = read.content.toString('utf8');
  const parsed = parseFrontmatter(source);
  if (!parsed.ok) {
    errors.push(
      err(
        narrativePath,
        '',
        parsed.message,
        hint(
          'parse-error',
          'The YAML frontmatter (between `---` fences at the top of the file) could not be parsed.',
        ),
      ),
    );
    return;
  }

  const validator = getValidators().narrativeFrontmatter;
  if (!validator(parsed.frontmatter)) {
    errors.push(...ajvErrorsToValidation(narrativePath, validator.errors));
    return;
  }

  const frontmatter = parsed.frontmatter as unknown as NarrativeFrontmatter;

  // Sanity check: when the reference site declared a language, the
  // narrative's frontmatter must agree.
  if (language !== undefined && frontmatter.language !== language) {
    errors.push(
      err(
        narrativePath,
        '/language',
        `Narrative "${narrativePath}" declares language "${frontmatter.language}" but is referenced under language key "${language}" in ${ownerFilePath}.`,
        hint(
          'schema-violation',
          'The frontmatter `language` field must match the language key under which the narrative is referenced.',
        ),
      ),
    );
  }

  // (4) B2B cascade: when the parent POI/standby/deeper-layer is `b2b`
  // and the narrative omits its own tier, the narrative still requires
  // sponsor + disclosure (Req 14.5, 20.4).
  const effectiveTier = frontmatter.tier ?? parentTier;
  if (effectiveTier === 'b2b') {
    const sponsorOk =
      typeof frontmatter.sponsor === 'string' && frontmatter.sponsor.length > 0;
    const disclosureOk =
      typeof frontmatter.disclosure === 'string' && frontmatter.disclosure.length > 0;
    if (!sponsorOk) {
      errors.push(
        err(
          narrativePath,
          '/sponsor',
          `Narrative "${narrativePath}" inherits tier "b2b" from its parent but has no non-empty \`sponsor\` field.`,
          hint(
            'b2b-disclosure-missing',
            'B2B narratives require both `sponsor` and `disclosure` (Requirements 14.5, 20.4).',
          ),
        ),
      );
    }
    if (!disclosureOk) {
      errors.push(
        err(
          narrativePath,
          '/disclosure',
          `Narrative "${narrativePath}" inherits tier "b2b" from its parent but has no non-empty \`disclosure\` field.`,
          hint(
            'b2b-disclosure-missing',
            'B2B narratives require both `sponsor` and `disclosure` (Requirements 14.5, 20.4).',
          ),
        ),
      );
    }
  }

  // (5) Every CC license entry must carry non-empty `id` and
  // `attribution`. The schema enforces this; this layer also enforces
  // it explicitly so future schema changes do not silently relax the
  // invariant.
  if (Array.isArray(frontmatter.licenses)) {
    for (let li = 0; li < frontmatter.licenses.length; li += 1) {
      const lic = frontmatter.licenses[li]!;
      if (typeof lic.id !== 'string' || lic.id.length === 0) {
        errors.push(
          err(
            narrativePath,
            pointerFromSegments(['licenses', li, 'id']),
            `Narrative "${narrativePath}" license entry #${li} has an empty or missing \`id\`.`,
            hint(
              'cc-license-incomplete',
              'CC license entries require both `id` and `attribution` (Requirement 17.2).',
            ),
          ),
        );
      }
      if (typeof lic.attribution !== 'string' || lic.attribution.length === 0) {
        errors.push(
          err(
            narrativePath,
            pointerFromSegments(['licenses', li, 'attribution']),
            `Narrative "${narrativePath}" license entry #${li} has an empty or missing \`attribution\`.`,
            hint(
              'cc-license-incomplete',
              'CC license entries require both `id` and `attribution` (Requirement 17.2).',
            ),
          ),
        );
      }
    }
  }

  narratives.set(narrativePath, {
    filePath: narrativePath,
    frontmatter,
    body: parsed.body,
  });
}

// ---------------------------------------------------------------------------
// Duplicate-id helper
// ---------------------------------------------------------------------------

function reportDuplicates<T extends string>(
  values: readonly T[],
  errorFor: (value: T, index: number) => BundleValidationError,
  errors: BundleValidationError[],
): void {
  const seen = new Map<T, number>();
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]!;
    const firstIdx = seen.get(v);
    if (firstIdx === undefined) {
      seen.set(v, i);
    } else {
      // Report the *second* (and any subsequent) occurrence so authors
      // know exactly which entry to remove or rename.
      errors.push(errorFor(v, i));
    }
  }
}
