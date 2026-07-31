// RouteSelectionScreen — Catalog routes with offline pack download + embedded fallback.
//
// FIX 3: PL/EN language selector defaulting from device locale.
// FIX 4: Rider-facing copy replacing dev text; 'How it works' affordance.
// FIX 5: Error surfacing on corrupt pack / loadInstalledTour failure.
// FIX 8: 44pt hit targets, WCAG-compliant contrast.

import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { PackRef } from '../../../storage/src/paths';
import type { StartTourConfig } from '../../../engine/src';
import { RoutePolylinePreview } from '../components/RoutePolylinePreview';
import { DEMO_ROUTES, type DemoRoute } from '../wiring/demoRoute';
import {
  usePackManager,
  type CatalogRouteEntry,
  type PackInstallState,
} from '../wiring/usePackManager';

export interface RouteSelectionScreenProps {
  onStartTour: (
    config: StartTourConfig,
    meta?: {
      title?: string;
      docsDir?: string;
      pack?: PackRef;
      narratives?: Readonly<Record<string, string>>;
      tones?: Readonly<Record<string, 'standard' | 'memorial'>>;
    },
  ) => void;
}

// ─── Language detection ───────────────────────────────────────────────────────

type TourLanguage = 'pl' | 'en';

function getDefaultLanguage(): TourLanguage {
  try {
    // Hermes supports Intl.DateTimeFormat().resolvedOptions().locale
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale.startsWith('pl')) return 'pl';
  } catch {
    // Fallback to English if Intl is unavailable.
  }
  return 'en';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function poiCenterMap(route: DemoRoute): Map<string, readonly [number, number]> {
  const map = new Map<string, readonly [number, number]>();
  for (const gf of route.tourConfig.geofences) {
    if (gf.geometry.kind === 'circle') {
      map.set(gf.poiId, gf.geometry.center);
    }
  }
  return map;
}

function routeKey(bundleId: string, version: string): string {
  return `${bundleId}@${version}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Language Selector ────────────────────────────────────────────────────────

function LanguageSelector({
  language,
  onChangeLanguage,
}: {
  language: TourLanguage;
  onChangeLanguage: (lang: TourLanguage) => void;
}): ReactElement {
  return (
    <View style={styles.languageCard}>
      <Text style={styles.languageTitle}>Narration language</Text>
      <View style={styles.languageRow}>
        <TouchableOpacity
          style={[styles.languageButton, language === 'pl' && styles.languageButtonSelected]}
          onPress={() => onChangeLanguage('pl')}
          accessibilityRole="button"
          accessibilityState={{ selected: language === 'pl' }}
          accessibilityLabel="Polish narration"
        >
          <Text
            style={[
              styles.languageButtonText,
              language === 'pl' && styles.languageButtonTextSelected,
            ]}
          >
            🇵🇱 Polski
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.languageButton, language === 'en' && styles.languageButtonSelected]}
          onPress={() => onChangeLanguage('en')}
          accessibilityRole="button"
          accessibilityState={{ selected: language === 'en' }}
          accessibilityLabel="English narration"
        >
          <Text
            style={[
              styles.languageButtonText,
              language === 'en' && styles.languageButtonTextSelected,
            ]}
          >
            🇬🇧 English
          </Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.languageHint}>Applies to the tour you start next.</Text>
    </View>
  );
}

// ─── How It Works ─────────────────────────────────────────────────────────────

function HowItWorks(): ReactElement {
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={styles.howItWorksCard}>
      <TouchableOpacity
        onPress={() => setExpanded((prev) => !prev)}
        style={styles.howItWorksHeader}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse how it works' : 'Expand how it works'}
        accessibilityState={{ expanded }}
      >
        <Text style={styles.howItWorksTitle}>How it works</Text>
        <Text style={styles.howItWorksChevron}>{expanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.howItWorksBody}>
          <Text style={styles.howItWorksStep}>
            <Text style={styles.howItWorksStepNum}>1.</Text> Board the bus and tap Start Tour.
          </Text>
          <Text style={styles.howItWorksStep}>
            <Text style={styles.howItWorksStepNum}>2.</Text> Put your phone away — narration plays
            through your headphones as you pass landmarks.
          </Text>
          <Text style={styles.howItWorksStep}>
            <Text style={styles.howItWorksStepNum}>3.</Text> Tap End Tour when you get off, or let
            it finish at the last stop.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ─── Catalog Route Card ───────────────────────────────────────────────────────

function CatalogRouteCard({
  route,
  state,
  preview,
  language,
  startError,
  onDownload,
  onStart,
}: {
  route: CatalogRouteEntry;
  state: PackInstallState;
  preview?: DemoRoute;
  language: TourLanguage;
  startError: string | null;
  onDownload: () => void;
  onStart: () => void;
}): ReactElement {
  const ready = state === 'ready';
  const downloading = state === 'downloading';

  return (
    <View style={styles.routeCard}>
      <Text style={styles.routeName}>{route.title}</Text>
      <Text style={styles.routeDescription}>{route.description}</Text>
      <Text style={styles.packMeta}>Offline pack · {formatBytes(route.sizeBytes)}</Text>

      {preview ? (
        <RoutePolylinePreview
          route={preview.tourConfig.route}
          pois={preview.pois}
          poiCenters={poiCenterMap(preview)}
        />
      ) : null}

      {downloading ? (
        <View style={styles.downloadRow}>
          <ActivityIndicator color="#2563eb" />
          <Text style={styles.downloadLabel}>Downloading offline pack…</Text>
        </View>
      ) : null}

      {startError ? <Text style={styles.startErrorText}>{startError}</Text> : null}

      <TouchableOpacity
        style={[styles.primaryButton, ready && styles.startButton]}
        onPress={ready ? onStart : onDownload}
        disabled={downloading}
        accessibilityRole="button"
        accessibilityLabel={
          ready
            ? `Start tour ${route.title} in ${language === 'pl' ? 'Polish' : 'English'}`
            : `Download offline pack for ${route.title}`
        }
      >
        <Text style={styles.primaryButtonText}>{ready ? 'Start Tour' : 'Download Pack'}</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export function RouteSelectionScreen({ onStartTour }: RouteSelectionScreenProps): ReactElement {
  const { routes, installState, error, catalogWarning, downloadPack, loadInstalledTour, storage } =
    usePackManager();

  const [language, setLanguage] = useState<TourLanguage>(getDefaultLanguage);
  const [startError, setStartError] = useState<string | null>(null);

  const embeddedById = new Map(DEMO_ROUTES.map((r) => [r.routeId, r]));
  const showEmbeddedFallback = routes.length === 0;

  const handleStartTourWithConfig = useCallback(
    (config: StartTourConfig, meta?: Parameters<typeof onStartTour>[1]) => {
      // FIX 3: Override language on the config at start time.
      const configWithLang: StartTourConfig = { ...config, language };
      onStartTour(configWithLang, meta);
    },
    [language, onStartTour],
  );

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Text style={styles.title} accessibilityRole="header">
        Tramio
      </Text>
      <Text style={styles.subtitle}>
        Board the bus, put on headphones, and hear narration triggered automatically as you pass
        landmarks. Download a pack over Wi‑Fi for offline maps and audio.
      </Text>

      <HowItWorks />

      {/* FIX 3: Language selector */}
      <LanguageSelector language={language} onChangeLanguage={setLanguage} />

      {!storage ? (
        <View style={styles.downloadRow}>
          <ActivityIndicator color="#2563eb" />
          <Text style={styles.downloadLabel}>Opening local storage…</Text>
        </View>
      ) : null}

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {catalogWarning ? <Text style={styles.warningText}>{catalogWarning}</Text> : null}

      {routes.map((route) => {
        const key = routeKey(route.bundleId, route.version);
        const preview = embeddedById.get(route.bundleId);
        return (
          <CatalogRouteCard
            key={key}
            route={route}
            state={installState[key] ?? 'missing'}
            {...(preview ? { preview } : {})}
            language={language}
            startError={startError}
            onDownload={() => void downloadPack(route.bundleId, route.version)}
            onStart={() => {
              setStartError(null);
              void loadInstalledTour(route.bundleId, route.version)
                .then((loaded) => {
                  handleStartTourWithConfig(loaded.config, {
                    title: loaded.title,
                    docsDir: loaded.docsDir,
                    pack: loaded.ref,
                    narratives: loaded.narratives,
                    tones: loaded.tones,
                  });
                })
                .catch((err: unknown) => {
                  const message =
                    err instanceof Error ? err.message : 'Failed to load the tour pack.';
                  setStartError(
                    `Could not start the tour: ${message}. Try re-downloading the pack.`,
                  );
                });
            }}
          />
        );
      })}

      {showEmbeddedFallback
        ? DEMO_ROUTES.map((route) => (
            <View key={route.routeId} style={styles.routeCard}>
              <Text style={styles.routeName}>{route.title}</Text>
              <Text style={styles.routeDescription}>{route.description}</Text>
              <RoutePolylinePreview
                route={route.tourConfig.route}
                pois={route.pois}
                poiCenters={poiCenterMap(route)}
              />
              <TouchableOpacity
                style={styles.startButton}
                onPress={() => handleStartTourWithConfig(route.tourConfig, { title: route.title })}
                accessibilityRole="button"
                accessibilityLabel={`Start tour ${route.title} in ${language === 'pl' ? 'Polish' : 'English'}`}
              >
                <Text style={styles.primaryButtonText}>Start Tour</Text>
              </TouchableOpacity>
            </View>
          ))
        : null}
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scrollContent: {
    flexGrow: 1,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    padding: 24,
    paddingBottom: 40,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    marginBottom: 8,
    color: '#1a1a1a',
  },
  subtitle: {
    fontSize: 14,
    color: '#374151',
    marginBottom: 20,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 360,
  },
  // ─── How It Works ────────────────────────────────────────────────────
  howItWorksCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#f9fafb',
    borderRadius: 12,
    marginBottom: 16,
    overflow: 'hidden',
  },
  howItWorksHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    minHeight: 44,
  },
  howItWorksTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  howItWorksChevron: {
    fontSize: 12,
    color: '#6b7280',
  },
  howItWorksBody: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 8,
  },
  howItWorksStep: {
    fontSize: 13,
    color: '#374151',
    lineHeight: 18,
  },
  howItWorksStepNum: {
    fontWeight: '700',
    color: '#2563eb',
  },
  // ─── Language Selector ──────────────────────────────────────────────
  languageCard: {
    width: '100%',
    maxWidth: 400,
    marginBottom: 20,
  },
  languageTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 8,
  },
  languageRow: {
    flexDirection: 'row',
    gap: 10,
  },
  languageButton: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d4d4d4',
    backgroundColor: '#ffffff',
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  languageButtonSelected: {
    borderColor: '#2563eb',
    backgroundColor: '#eff6ff',
  },
  languageButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#444',
  },
  languageButtonTextSelected: {
    color: '#1d4ed8',
  },
  languageHint: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 6,
  },
  // ─── Route Cards ────────────────────────────────────────────────────
  routeCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
  },
  routeName: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: 6,
  },
  routeDescription: {
    fontSize: 14,
    color: '#374151',
    lineHeight: 20,
    marginBottom: 8,
  },
  packMeta: {
    fontSize: 12,
    color: '#4b5563',
    marginBottom: 12,
  },
  downloadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: 12,
  },
  downloadLabel: {
    fontSize: 14,
    color: '#374151',
  },
  errorText: {
    color: '#dc2626',
    fontSize: 14,
    marginBottom: 12,
    textAlign: 'center',
  },
  startErrorText: {
    color: '#dc2626',
    fontSize: 13,
    marginTop: 8,
    marginBottom: 4,
    lineHeight: 18,
  },
  warningText: {
    color: '#92400e',
    fontSize: 13,
    marginBottom: 12,
    textAlign: 'center',
    lineHeight: 18,
    maxWidth: 360,
  },
  primaryButton: {
    backgroundColor: '#0f766e',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
    alignSelf: 'center',
    marginTop: 12,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startButton: {
    backgroundColor: '#2563eb',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
