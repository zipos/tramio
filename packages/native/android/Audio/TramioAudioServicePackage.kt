// TramioAudioServicePackage.kt
//
// `ReactPackage` wiring for the Audio_Service Android module
// (task 8.4). Registered with the host app's `MainApplication` so
// `NativeModules.TramioAudioService` resolves on the JS side.
//
// The host app's `getPackages()` list adds:
//
//     packages.add(TramioAudioServicePackage())
//
// The Expo bare prebuild step regenerates `android/`; the Tramio Expo
// config plugin owns inserting this package into the generated
// `MainApplication`. Until task 13.1 wires that plugin, manual
// registration in the prebuilt project is sufficient.

package app.tramio.client.audio

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class TramioAudioServicePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(TramioAudioServiceModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
