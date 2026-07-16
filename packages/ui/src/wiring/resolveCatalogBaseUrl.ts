// resolveCatalogBaseUrl — dev catalog host for physical devices vs emulator.

import Constants from 'expo-constants';
import { NativeModules } from 'react-native';

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

function isLoopbackUrl(url: string): boolean {
  return /\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/u.test(url);
}

function readMetroBundlerHost(): string | null {
  const source = NativeModules.SourceCode as { scriptURL?: string } | undefined;
  const scriptURL = source?.scriptURL;
  if (typeof scriptURL === 'string' && scriptURL.length > 0) {
    const match = scriptURL.match(/^https?:\/\/([^/:]+)/u);
    const host = match?.[1];
    if (host && !isLoopbackHost(host)) {
      return host;
    }
  }

  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants.expoGoConfig as { debuggerHost?: string } | null)?.debuggerHost ??
    Constants.manifest?.debuggerHost;
  if (typeof hostUri === 'string' && hostUri.length > 0) {
    const host = hostUri.replace(/^[^:]+:\/\//u, '').split(':')[0];
    if (host && !isLoopbackHost(host)) {
      return host;
    }
  }

  return null;
}

/**
 * Catalog REST base URL. In dev on a physical phone, Metro's bundle host (same
 * machine as `npm run backend:dev`, port 8080) replaces baked-in localhost.
 */
export function resolveCatalogBaseUrl(): string {
  const extra = Constants.expoConfig?.extra as { catalogBaseUrl?: string } | undefined;
  const configured = extra?.catalogBaseUrl ?? 'http://127.0.0.1:8080';
  if (!isLoopbackUrl(configured)) {
    return configured.replace(/\/+$/u, '');
  }

  const metroHost = readMetroBundlerHost();
  if (metroHost) {
    return `http://${metroHost}:8080`;
  }

  return configured.replace(/\/+$/u, '');
}

export function formatCatalogUnreachableMessage(baseUrl: string): string {
  if (isLoopbackUrl(baseUrl)) {
    return (
      'Dev catalog not reachable (127.0.0.1 is your phone, not your Mac). ' +
      'Run npm run backend:dev on your computer — embedded demo routes still work below.'
    );
  }
  return (
    `Catalog not reachable at ${baseUrl}. ` +
    'Start the dev backend on your Mac with npm run backend:dev — embedded demo routes still work below.'
  );
}
