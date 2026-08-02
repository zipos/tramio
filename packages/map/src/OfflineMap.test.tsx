/**
 * Unit tests for the OfflineMap component.
 *
 * Validates:
 * - Component renders with offline tile source (Req 4.1)
 * - No external URLs in the generated style (Req 3.2, 4.4)
 * - Route / POI / user overlays mount when provided
 * - onMapReady callback fires
 */

import React from 'react';
import { create, act } from 'react-test-renderer';

import { OfflineMap } from './OfflineMap';

describe('OfflineMap', () => {
  const defaultProps = {
    tilePack: { bundleId: 'wroclaw-tram-7-east', version: '1.4.2' },
    docsDir: '/data/docs',
  };

  it('renders without crashing', () => {
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<OfflineMap {...defaultProps} />);
    });
    expect(tree?.toJSON()).toBeTruthy();
  });

  it('passes a mapStyle with no external URLs to MapView', () => {
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<OfflineMap {...defaultProps} />);
    });

    const root = tree!.root;
    const mapView = root.findByProps({ testID: 'maplibre-mapview' });
    const mapStyle = mapView.props.mapStyle as Record<string, unknown>;
    const styleJSON = JSON.stringify(mapStyle);

    expect(styleJSON).not.toMatch(/https?:\/\//);
    expect(styleJSON).toContain('file:///data/docs/packs/wroclaw-tram-7-east/1.4.2/tiles/');
  });

  it('does not reference Google Maps, Apple MapKit, or Mapbox (Req 4.4)', () => {
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<OfflineMap {...defaultProps} />);
    });

    const root = tree!.root;
    const mapView = root.findByProps({ testID: 'maplibre-mapview' });
    const styleJSON = JSON.stringify(mapView.props.mapStyle);

    expect(styleJSON.toLowerCase()).not.toContain('google');
    expect(styleJSON.toLowerCase()).not.toContain('mapkit');
    expect(styleJSON.toLowerCase()).not.toContain('mapbox');
  });

  it('calls onMapReady when the map finishes loading', () => {
    const onMapReady = jest.fn();
    act(() => {
      create(<OfflineMap {...defaultProps} onMapReady={onMapReady} />);
    });

    expect(onMapReady).toHaveBeenCalledTimes(1);
  });

  it('uses the correct tile path from bundleId and version', () => {
    const props = {
      tilePack: { bundleId: 'berlin-bus-100', version: '2.1.0' },
      docsDir: '/app/documents',
    };

    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<OfflineMap {...props} />);
    });

    const root = tree!.root;
    const mapView = root.findByProps({ testID: 'maplibre-mapview' });
    const styleJSON = JSON.stringify(mapView.props.mapStyle);

    expect(styleJSON).toContain(
      'file:///app/documents/packs/berlin-bus-100/2.1.0/tiles/{z}/{x}/{y}.pbf',
    );
  });

  it('renders an empty style when tilePack has invalid bundleId', () => {
    const props = {
      tilePack: { bundleId: '', version: '1.0.0' },
      docsDir: '/data/docs',
    };

    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<OfflineMap {...props} />);
    });

    const root = tree!.root;
    const mapView = root.findByProps({ testID: 'maplibre-mapview' });
    const parsed = mapView.props.mapStyle as { sources: unknown; layers: unknown };

    expect(parsed.sources).toEqual({});
    expect(parsed.layers).toEqual([]);
  });

  it('sets accessibility role and label on the container', () => {
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<OfflineMap {...defaultProps} />);
    });

    const json = tree!.toJSON() as { props: Record<string, unknown> };
    expect(json.props.accessibilityRole).toBe('image');
    expect(json.props.accessibilityLabel).toBe('Offline map view');
  });

  it('disables built-in attribution on MapView (static overlay instead)', () => {
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<OfflineMap {...defaultProps} />);
    });

    const root = tree!.root;
    const mapView = root.findByProps({ testID: 'maplibre-mapview' });
    expect(mapView.props.attributionEnabled).toBe(false);
  });

  it('renders route, POI, and user ShapeSources when overlays are provided', () => {
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(
        <OfflineMap
          {...defaultProps}
          route={[
            [52.23, 21.01],
            [52.24, 21.02],
          ]}
          pois={[
            {
              poiId: 'poi-a',
              center: [52.235, 21.015],
              radiusMeters: 40,
              highlight: true,
            },
            {
              poiId: 'poi-b',
              center: [52.238, 21.018],
              radiusMeters: 40,
              consumed: true,
            },
          ]}
          userPosition={[52.232, 21.012]}
        />,
      );
    });

    const root = tree!.root;
    expect(root.findByProps({ testID: 'maplibre-shapesource-tramio-route' })).toBeTruthy();
    expect(root.findByProps({ testID: 'maplibre-shapesource-tramio-pois' })).toBeTruthy();
    expect(root.findByProps({ testID: 'maplibre-shapesource-tramio-user' })).toBeTruthy();
    expect(root.findByProps({ testID: 'maplibre-linelayer-tramio-route-line' })).toBeTruthy();
    expect(root.findByProps({ testID: 'maplibre-circlelayer-tramio-pois-next' })).toBeTruthy();
    expect(root.findByProps({ testID: 'maplibre-circlelayer-tramio-user-dot' })).toBeTruthy();
  });
});
