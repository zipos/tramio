/**
 * Mock for @maplibre/maplibre-react-native used in Jest tests.
 *
 * Provides minimal implementations of MapView, Camera, and the
 * setAccessToken function so the OfflineMap component can be tested
 * without native module dependencies.
 */

import React from 'react';

function MockView(props: Record<string, unknown>) {
  return React.createElement('View', props, props.children as React.ReactNode);
}

const MapView = React.forwardRef(function MapView(
  props: Record<string, unknown>,
  _ref: React.Ref<unknown>,
) {
  const { children, onDidFinishLoadingMap, ...rest } = props;
  React.useEffect(() => {
    if (typeof onDidFinishLoadingMap === 'function') {
      onDidFinishLoadingMap();
    }
  }, [onDidFinishLoadingMap]);

  return React.createElement(MockView, { testID: 'maplibre-mapview', ...rest }, children as React.ReactNode);
});

function Camera(props: Record<string, unknown>) {
  return React.createElement(MockView, { testID: 'maplibre-camera', ...props });
}

function setAccessToken(_token: string | null): void {
  // No-op in tests
}

const MapLibreGL = {
  MapView,
  Camera,
  setAccessToken,
};

export default MapLibreGL;
