/*
 * TramioTtsEnginePackage.kt
 * @tramio/native — Android `ReactPackage` for TTS_Engine (task 8.6).
 *
 * Registers `TramioTtsEngineModule` so the React Native bridge can
 * find it under the name "TramioTtsEngine" (matching the iOS
 * `RCT_EXPORT_MODULE` value). The consuming Expo bare project's
 * `MainApplication.kt` adds an instance of this package to its
 * `getPackages()` list, exactly the same way the upcoming Audio /
 * Location packages will be wired (task 13.1).
 *
 * No view managers are exposed; this is a JS-only module.
 */

package app.tramio.client.tts

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class TramioTtsEnginePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(TramioTtsEngineModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
