/*
 * TramioLocationServicePackage.kt
 * @tramio/native — Location_Service Android `ReactPackage` (task 8.2).
 *
 * Registers `TramioLocationServiceModule` with the React Native bridge.
 * The host app's `MainApplication.getPackages()` adds an instance of
 * this class to the returned list:
 *
 *     packages.add(TramioLocationServicePackage())
 *
 * No view managers are exported — Location_Service is a headless module.
 */

package com.tramio.location

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class TramioLocationServicePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(TramioLocationServiceModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
