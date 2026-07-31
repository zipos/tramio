/**
 * Mock for @maplibre/maplibre-react-native used in Jest tests.
 *
 * Provides minimal implementations of MapView, Camera, ShapeSource,
 * LineLayer, CircleLayer, and the setAccessToken function so the
 * OfflineMap component can be tested without native module dependencies.
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

  return React.createElement(
    MockView,
    { testID: 'maplibre-mapview', ...rest },
    children as React.ReactNode,
  );
});

function Camera(props: Record<string, unknown>) {
  return React.createElement(MockView, { testID: 'maplibre-camera', ...props });
}

function ShapeSource(props: Record<string, unknown>) {
  return React.createElement(
    MockView,
    { testID: `maplibre-shapesource-${props.id ?? 'unknown'}`, ...props },
    props.children as React.ReactNode,
  );
}

function LineLayer(props: Record<string, unknown>) {
  return React.createElement(MockView, {
    testID: `maplibre-linelayer-${props.id ?? 'unknown'}`,
    ...props,
  });
}

function CircleLayer(props: Record<string, unknown>) {
  return React.createElement(MockView, {
    testID: `maplibre-circlelayer-${props.id ?? 'unknown'}`,
    ...props,
  });
}

function setAccessToken(_token: string | null): void {
  // No-op in tests
}

const MapLibreGL = {
  MapView,
  Camera,
  ShapeSource,
  LineLayer,
  CircleLayer,
  setAccessToken,
};

export default MapLibreGL;
