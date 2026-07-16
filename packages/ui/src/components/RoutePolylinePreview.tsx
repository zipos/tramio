// RoutePolylinePreview — lightweight route sketch without map tiles.
//
// Renders the demo route polyline and POI markers in a fixed aspect box so
// recruiters can see geography before a tile pack exists (storage Option C).

import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { LatLng } from '../../../engine/src';
import type { DemoPoi } from '../wiring/demoRoute';

export interface RoutePolylinePreviewProps {
  route: readonly LatLng[];
  pois: readonly DemoPoi[];
  poiCenters: ReadonlyMap<string, LatLng>;
}

interface PlotPoint {
  x: number;
  y: number;
}

function projectPoints(
  route: readonly LatLng[],
  pois: readonly DemoPoi[],
  poiCenters: ReadonlyMap<string, LatLng>,
  width: number,
  height: number,
): { routePts: PlotPoint[]; poiPts: Array<PlotPoint & { label: string }> } {
  const all: LatLng[] = [...route];
  for (const poi of pois) {
    const center = poiCenters.get(poi.poiId);
    if (center) all.push(center);
  }
  if (all.length === 0) {
    return { routePts: [], poiPts: [] };
  }

  let minLat = all[0]![0];
  let maxLat = all[0]![0];
  let minLng = all[0]![1];
  let maxLng = all[0]![1];
  for (const [lat, lng] of all) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }

  const pad = 0.15;
  const latSpan = Math.max(maxLat - minLat, 0.0001);
  const lngSpan = Math.max(maxLng - minLng, 0.0001);
  const latPad = latSpan * pad;
  const lngPad = lngSpan * pad;

  const toPlot = ([lat, lng]: LatLng): PlotPoint => ({
    x: ((lng - (minLng - lngPad)) / (lngSpan + 2 * lngPad)) * width,
    y: (1 - (lat - (minLat - latPad)) / (latSpan + 2 * latPad)) * height,
  });

  const routePts = route.map(toPlot);
  const poiPts = pois.flatMap((poi) => {
    const center = poiCenters.get(poi.poiId);
    if (!center) return [];
    const pt = toPlot(center);
    return [{ ...pt, label: poi.label }];
  });

  return { routePts, poiPts };
}

const WIDTH = 280;
const HEIGHT = 140;

export function RoutePolylinePreview({
  route,
  pois,
  poiCenters,
}: RoutePolylinePreviewProps): ReactElement {
  const { routePts, poiPts } = projectPoints(route, pois, poiCenters, WIDTH, HEIGHT);

  return (
    <View style={styles.wrapper} accessibilityRole="image" accessibilityLabel="Route map preview">
      <View style={[styles.canvas, { width: WIDTH, height: HEIGHT }]}>
        {routePts.map((pt, i) => {
          if (i === 0) return null;
          const prev = routePts[i - 1]!;
          const dx = pt.x - prev.x;
          const dy = pt.y - prev.y;
          const length = Math.sqrt(dx * dx + dy * dy);
          const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
          return (
            <View
              key={`seg-${i}`}
              style={[
                styles.segment,
                {
                  width: length,
                  left: prev.x,
                  top: prev.y,
                  transform: [{ rotate: `${angle}deg` }],
                },
              ]}
            />
          );
        })}
        {routePts.map((pt, i) => (
          <View key={`route-${i}`} style={[styles.routeDot, { left: pt.x - 3, top: pt.y - 3 }]} />
        ))}
        {poiPts.map((pt) => (
          <View
            key={pt.label}
            style={[styles.poiDot, { left: pt.x - 5, top: pt.y - 5 }]}
            accessibilityLabel={pt.label}
          />
        ))}
      </View>
      <Text style={styles.hint}>Approximate route · offline map tiles not loaded</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    alignItems: 'center',
    marginBottom: 16,
  },
  canvas: {
    backgroundColor: '#e8f4fc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bfdbfe',
    overflow: 'hidden',
    position: 'relative',
  },
  segment: {
    position: 'absolute',
    height: 2,
    backgroundColor: '#2563eb',
    transformOrigin: 'left center',
  },
  routeDot: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#93c5fd',
  },
  poiDot: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#dc2626',
    borderWidth: 1,
    borderColor: '#ffffff',
  },
  hint: {
    marginTop: 6,
    fontSize: 11,
    color: '#64748b',
    textAlign: 'center',
  },
});
