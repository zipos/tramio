// @tramio/branding
//
// Single source of truth for public-brand strings and identifiers. Consumed by
// UI, Catalog_Client, Entitlement_Client, and the platform-config generators
// (Expo `app.config.ts`, iOS `Info.plist` template, Android `build.gradle`
// applicationId). Runtime endpoint URLs (CATALOG_BASE_URL,
// ENTITLEMENT_BASE_URL) are NOT part of this module — they are resolved from
// environment-based config so the primary domain can be swapped at deploy time.

export interface BrandConfig {
  readonly displayName: 'Tramio';
  readonly primaryDomain: 'tramio.app';
  readonly supportUrl: string;
  readonly deepLinkScheme: 'tramio';
  readonly bundleIdProd: 'app.tramio.client';
  readonly bundleIdDev: 'app.tramio.client.dev';
}

export const BRAND: BrandConfig = Object.freeze({
  displayName: 'Tramio',
  primaryDomain: 'tramio.app',
  supportUrl: 'https://tramio.app/support',
  deepLinkScheme: 'tramio',
  bundleIdProd: 'app.tramio.client',
  bundleIdDev: 'app.tramio.client.dev',
});
