# Keep ReactPackage and module classes so reflective registration in
# MainApplication continues to work after R8 / Proguard shrinking.
-keep class com.tramio.location.TramioLocationServiceModule { *; }
-keep class com.tramio.location.TramioLocationServicePackage { *; }
-keep class com.tramio.location.TramioTourForegroundService { *; }
-keep class com.tramio.location.TramioGeofenceBroadcastReceiver { *; }
