/**
 * Type declarations for @maplibre/maplibre-react-native.
 *
 * This is a minimal declaration covering only the API surface used by
 * the @tramio/map package. The full types ship with the actual package
 * when installed as a peer dependency in the app.
 */

declare module '@maplibre/maplibre-react-native' {
  import type { ComponentType } from 'react';
  import type { ViewStyle } from 'react-native';

  interface MapViewProps {
    style?: ViewStyle;
    styleJSON?: string;
    styleURL?: string;
    logoEnabled?: boolean;
    attributionEnabled?: boolean;
    telemetryEnabled?: boolean;
    onDidFinishLoadingMap?: () => void;
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
  }

  interface MapLibreGL {
    MapView: ComponentType<MapViewProps>;
    Camera: ComponentType<CameraProps>;
    setAccessToken(token: string | null): void;
  }

  const MapLibreGL: MapLibreGL;
  export default MapLibreGL;
}
