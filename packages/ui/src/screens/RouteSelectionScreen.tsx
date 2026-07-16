// RouteSelectionScreen — Catalog routes with offline pack download + embedded fallback.

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
    },
  ) => void;
}

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

function CatalogRouteCard({
  route,
  state,
  preview,
  onDownload,
  onStart,
}: {
  route: CatalogRouteEntry;
  state: PackInstallState;
  preview?: DemoRoute;
  onDownload: () => void;
  onStart: () => void;
}): ReactElement {
  const key = routeKey(route.bundleId, route.version);
  const ready = state === 'ready';
  const downloading = state === 'downloading';

  return (
    <View style={styles.routeCard}>
      <Text style={styles.routeName}>{route.title}</Text>
      <Text style={styles.routeDescription}>{route.description}</Text>
      <Text style={styles.packMeta}>
        Pack {route.bundleId}@{route.version} · {formatBytes(route.sizeBytes)}
      </Text>

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

      <TouchableOpacity
        style={[styles.primaryButton, ready && styles.startButton]}
        onPress={ready ? onStart : onDownload}
        disabled={downloading}
        accessibilityRole="button"
        accessibilityLabel={ready ? `Start tour ${route.title}` : `Download pack ${key}`}
      >
        <Text style={styles.primaryButtonText}>{ready ? 'Start Tour' : 'Download Pack'}</Text>
      </TouchableOpacity>
    </View>
  );
}

export function RouteSelectionScreen({ onStartTour }: RouteSelectionScreenProps): ReactElement {
  const { routes, installState, error, catalogWarning, downloadPack, loadInstalledTour, storage } =
    usePackManager();

  const embeddedById = new Map(DEMO_ROUTES.map((r) => [r.routeId, r]));
  const showEmbeddedFallback = routes.length === 0;

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Text style={styles.title} accessibilityRole="header">
        Tramio
      </Text>
      <Text style={styles.subtitle}>
        Download an offline pack over Wi‑Fi, then start a tour. Packs include map tiles, route
        geometry, and narratives (Storage_Manager + expo-file-system).
      </Text>

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
            onDownload={() => void downloadPack(route.bundleId, route.version)}
            onStart={() => {
              void loadInstalledTour(route.bundleId, route.version)
                .then((loaded) => {
                  onStartTour(loaded.config, {
                    title: loaded.title,
                    docsDir: loaded.docsDir,
                    pack: loaded.ref,
                    narratives: loaded.narratives,
                  });
                })
                .catch(() => undefined);
            }}
          />
        );
      })}

      {showEmbeddedFallback
        ? DEMO_ROUTES.map((route) => (
            <View key={route.routeId} style={styles.routeCard}>
              <Text style={styles.routeName}>{route.title} (embedded fallback)</Text>
              <Text style={styles.routeDescription}>{route.description}</Text>
              <RoutePolylinePreview
                route={route.tourConfig.route}
                pois={route.pois}
                poiCenters={poiCenterMap(route)}
              />
              <TouchableOpacity
                style={styles.startButton}
                onPress={() => onStartTour(route.tourConfig, { title: route.title })}
                accessibilityRole="button"
              >
                <Text style={styles.primaryButtonText}>Start Tour (no pack)</Text>
              </TouchableOpacity>
            </View>
          ))
        : null}
    </ScrollView>
  );
}

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
    color: '#666',
    marginBottom: 24,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 360,
  },
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
    color: '#555',
    lineHeight: 20,
    marginBottom: 8,
  },
  packMeta: {
    fontSize: 12,
    color: '#64748b',
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
    color: '#444',
  },
  errorText: {
    color: '#dc2626',
    fontSize: 14,
    marginBottom: 12,
    textAlign: 'center',
  },
  warningText: {
    color: '#b45309',
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
