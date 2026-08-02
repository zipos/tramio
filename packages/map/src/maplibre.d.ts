/**
 * Type declarations for @maplibre/maplibre-react-native.
 *
 * Minimal surface used by @tramio/map. Full types ship with the package
 * when installed as a peer dependency in the app.
 */

declare module '@maplibre/maplibre-react-native' {
  import type { ComponentType } from 'react';
  import type { ViewStyle } from 'react-native';

  interface RegionPayload {
    zoomLevel: number;
    heading: number;
    animated: boolean;
    isUserInteraction: boolean;
    pitch: number;
  }

  interface MapViewProps {
    style?: ViewStyle;
    mapStyle?: string | Record<string, unknown>;
    logoEnabled?: boolean;
    attributionEnabled?: boolean;
    compassEnabled?: boolean;
    onDidFinishLoadingMap?: () => void;
    onRegionDidChange?: (feature: GeoJSON.Feature<GeoJSON.Point, RegionPayload>) => void;
    children?: React.ReactNode;
  }

  interface CameraDefaultSettings {
    centerCoordinate?: [number, number];
    zoomLevel?: number;
    heading?: number;
    pitch?: number;
  }

  interface CameraProps {
    defaultSettings?: CameraDefaultSettings;
    centerCoordinate?: [number, number];
    zoomLevel?: number;
    heading?: number;
    pitch?: number;
    animationDuration?: number;
    animationMode?: string;
    followUserLocation?: boolean;
    children?: React.ReactNode;
  }

  interface ShapeSourceProps {
    id: string;
    shape?: GeoJSON.Feature | GeoJSON.FeatureCollection | GeoJSON.Geometry;
    children?: React.ReactNode;
  }

  interface LineLayerProps {
    id: string;
    style?: Record<string, unknown>;
  }

  interface CircleLayerProps {
    id: string;
    style?: Record<string, unknown>;
    filter?: unknown[];
  }

  interface MapLibreGL {
    MapView: ComponentType<MapViewProps>;
    Camera: ComponentType<CameraProps>;
    ShapeSource: ComponentType<ShapeSourceProps>;
    LineLayer: ComponentType<LineLayerProps>;
    CircleLayer: ComponentType<CircleLayerProps>;
    setAccessToken(token: string | null): void;
  }

  const MapLibreGL: MapLibreGL;
  export default MapLibreGL;
}
