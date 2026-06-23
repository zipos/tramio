/**
 * Flag-driven dispatch helper for command translators (task 9.2).
 *
 * Per Requirements 15.2 / 15.3 / 15.4 and design.md "Capability_Layer" /
 * "Capability Layer Strategy", command translators MUST select the modern
 * vs fallback path purely from a `Capabilities` flag, never from
 * `Platform.OS` / `Platform.Version` directly. This helper is the
 * single chokepoint that enforces that rule.
 *
 * Recommended consumption pattern (paraphrased from design.md):
 *
 *     // Command translator for Location_Service.armGeofences(...)
 *     import { dispatchByCapability, useCapabilities } from '@tramio/capability';
 *
 *     const armGeofencesV2 = (gs: Geofence[]) => nativeArmV2(gs);
 *     const armGeofencesLegacy = (gs: Geofence[]) => nativeArmLegacy(gs);
 *
 *     export function useArmGeofences(): (gs: Geofence[]) => void {
 *       const caps = useCapabilities();
 *       return dispatchByCapability(caps, {
 *         regionMonitoringV2: {
 *           modern: armGeofencesV2,
 *           fallback: armGeofencesLegacy,
 *         },
 *       });
 *     }
 *
 * The translator never reads `Platform.Version`; it reads
 * `caps.regionMonitoringV2`. Both branches share the same `EngineCommand`
 * surface, so the engine reducer is unchanged.
 *
 * The mapping is intentionally constrained to *one* flag per dispatch call:
 * a single flag-keyed branch keeps each translator decision auditable and
 * keeps the property test in task 9.3 (P18) tractable. If a translator
 * needs to multiplex on more than one flag, compose two
 * `dispatchByCapability` calls.
 */
import type { Capabilities, CapabilityFlag } from './types';

/**
 * Pair of variants for one capability flag.
 *
 * `modern`   — the path used when `caps[flag] === true`.
 * `fallback` — the path used when `caps[flag] === false` (and is the
 *              documented legacy path declared in `OS_MATRIX[flag]`).
 *
 * Both fields are required so callers cannot accidentally leave one branch
 * undefined and trip a runtime undefined-call (Req 15.4).
 */
export interface CapabilityVariants<T> {
  readonly modern: T;
  readonly fallback: T;
}

/**
 * Mapping shape: a partial record keyed by capability flag, with a
 * `{ modern, fallback }` pair as the value.
 *
 * In practice every call site passes exactly one entry. The runtime check
 * below rejects any other arity so misuse fails loud at the dispatch site
 * rather than silently picking an arbitrary flag.
 */
export type CapabilityDispatchMapping<T> = Partial<
  Record<CapabilityFlag, CapabilityVariants<T>>
>;

/**
 * Pick the modern or fallback variant for a capability flag.
 *
 * @param caps     Frozen `Capabilities` snapshot from
 *                 `probeCapabilities()` (typically threaded through
 *                 `useCapabilities()`).
 * @param mapping  Object with **exactly one** capability flag as a key,
 *                 paired with its `{ modern, fallback }` variants.
 * @returns        `mapping[flag].modern` if `caps[flag]` is `true`,
 *                 otherwise `mapping[flag].fallback`.
 *
 * Throws if the mapping has zero or more-than-one entry: either case is a
 * programmer error and would otherwise hide which flag drove the decision.
 */
export function dispatchByCapability<T>(
  caps: Capabilities,
  mapping: CapabilityDispatchMapping<T>,
): T {
  // Object.keys gives strings; we narrow to CapabilityFlag because the
  // input type is keyed by CapabilityFlag.
  const flags = Object.keys(mapping) as CapabilityFlag[];
  if (flags.length === 0) {
    throw new Error(
      'dispatchByCapability: mapping must declare exactly one capability flag, got none',
    );
  }
  if (flags.length > 1) {
    throw new Error(
      `dispatchByCapability: mapping must declare exactly one capability flag, got ${flags.length} (${flags.join(', ')})`,
    );
  }
  const flag = flags[0]!;
  const variants = mapping[flag];
  // `flags` was built from Object.keys so `variants` is always defined; the
  // check satisfies strict optional typing.
  if (!variants) {
    throw new Error(`dispatchByCapability: missing variants for flag ${flag}`);
  }
  return caps[flag] ? variants.modern : variants.fallback;
}
