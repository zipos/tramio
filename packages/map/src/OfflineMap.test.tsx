/**
 * Unit tests for the OfflineMap component.
 *
 * Validates:
 * - Component renders with offline tile source (Req 4.1)
 * - No external URLs in the generated style (Req 3.2, 4.4)
 * - Correct tile path resolution from bundleId/version props
 * - onMapReady callback fires
 *
 * @see Requirements 3.2, 4.1, 4.4
 */

import React from 'react';
import { create, act } from 'react-test-renderer';

// @maplibre/maplibre-react-native is resolved via moduleNameMapper in jest.config.js
// to src/__mocks__/maplibre-react-native.ts

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

  it('passes a styleJSON with no external URLs to MapView', () => {
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<OfflineMap {...defaultProps} />);
    });

    const root = tree!.root;
    const mapView = root.findByProps({ testID: 'maplibre-mapview' });
    const styleJSON = mapView.props.styleJSON as string;

    // Parse the style and verify no http/https URLs
    expect(styleJSON).not.toMatch(/https?:\/\//);
    // Verify it contains the correct file:// path
    expect(styleJSON).toContain('file:///data/docs/packs/wroclaw-tram-7-east/1.4.2/tiles/');
  });

  it('does not reference Google Maps, Apple MapKit, or Mapbox (Req 4.4)', () => {
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<OfflineMap {...defaultProps} />);
    });

    const root = tree!.root;
    const mapView = root.findByProps({ testID: 'maplibre-mapview' });
    const styleJSON = mapView.props.styleJSON as string;

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
    const styleJSON = mapView.props.styleJSON as string;

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
    const styleJSON = mapView.props.styleJSON as string;
    const parsed = JSON.parse(styleJSON);

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

  it('disables telemetry on MapView (no outbound requests)', () => {
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<OfflineMap {...defaultProps} />);
    });

    const root = tree!.root;
    const mapView = root.findByProps({ testID: 'maplibre-mapview' });
    expect(mapView.props.telemetryEnabled).toBe(false);
  });
});
