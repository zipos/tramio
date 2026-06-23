// @ts-check
const {
  AndroidConfig,
  withAndroidManifest,
} = require('@expo/config-plugins');

/**
 * Adds the Android foreground service component used by Tramio's
 * Location_Service and Audio_Service modules to keep the tour alive in the
 * background.
 *
 * The native foreground service class itself will be implemented as part of
 * task 8.2 (Android Location_Service) and task 8.4 (Android Audio_Service);
 * this plugin only registers the manifest entry so prebuild produces a
 * `<service>` declaration with the right `foregroundServiceType` flags
 * (`location` + `mediaPlayback`).
 *
 * Validates: Requirements 12.1, 12.2, 12.4
 *
 * @type {import('@expo/config-plugins').ConfigPlugin}
 */
const withTramioForegroundService = (config) => {
  return withAndroidManifest(config, (modConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(
      modConfig.modResults,
    );

    const SERVICE_NAME = '.TramioTourForegroundService';
    const SERVICE_TYPES = 'location|mediaPlayback';

    application.service = application.service ?? [];

    const existing = application.service.find(
      (svc) => svc.$ && svc.$['android:name'] === SERVICE_NAME,
    );

    if (existing) {
      existing.$['android:enabled'] = 'true';
      existing.$['android:exported'] = 'false';
      existing.$['android:foregroundServiceType'] = SERVICE_TYPES;
    } else {
      application.service.push({
        $: {
          'android:name': SERVICE_NAME,
          'android:enabled': 'true',
          'android:exported': 'false',
          'android:foregroundServiceType': SERVICE_TYPES,
        },
      });
    }

    return modConfig;
  });
};

module.exports = withTramioForegroundService;
module.exports.default = withTramioForegroundService;
