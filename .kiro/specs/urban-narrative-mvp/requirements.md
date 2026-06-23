# Requirements Document

## Introduction

Tramio is a cross-platform mobile application (iOS and Android, built in React Native) that turns ordinary rides on local public transit (buses, trams) into geofenced audio-guided tours. Instead of paying for commercial Hop-on Hop-off services, a traveler boards a regular city transit line and the app narrates landmarks, mundane architectural details, and contextual trivia synchronized to the vehicle's real-world position along the route.

The MVP targets a single city with one to two curated transit routes. Content is authored as standardized JSON and Markdown files so that adding a new route is reducible to "typing markdown into an AI model harness" and dropping the resulting bundle into the catalog.

The MVP must operate offline during the trip (maps, route coordinates, points of interest, and audio assets pre-downloaded over WiFi), avoid commercial map and geolocation APIs to keep total cost of ownership low, tolerate GPS noise and urban canyon errors, and degrade gracefully when the vehicle is stuck in traffic, enters a tunnel, or the user deviates from the planned route. The data model and runtime state must be ready to support future freemium gating, 24/48-hour time passes, gamified token unlocks for deeper trivia layers, and geofenced B2B micro-narratives without rework.

The application prefers OS-native capabilities (CoreLocation region monitoring, GeofencingClient + FusedLocationProvider, AVSpeechSynthesizer / Android TextToSpeech, AVFoundation / ExoPlayer) accessed through thin React Native turbo modules, with a capability-detection layer so newer OS APIs can be adopted as they ship.

Offline content protection targets **casual-piracy resistance**, not airtight DRM. The goal is to raise the cost of casually copying a pack directory from one device to another, so that a simple file-share attack does not yield usable narratives. Hardware-backed key wrapping, signed license tokens, per-asset integrity signatures, and just-in-time decryption are sized to deter casual sharing while preserving fully offline playability and accessibility for legitimate users. The system explicitly does not attempt to defeat a determined attacker with full reverse-engineering capability; the cost-of-attack envelope ends at "more effort than buying a time pass."

## Glossary

- **App**: The Tramio React Native application running on the user's device.
- **Tour_Engine**: The runtime subsystem responsible for evaluating geofence triggers, sequencing narrative segments, and coordinating audio playback.
- **Location_Service**: The native module wrapping CoreLocation (iOS) and FusedLocationProviderClient + GeofencingClient (Android), responsible for delivering filtered position updates and geofence events.
- **Audio_Service**: The native module wrapping AVFoundation (iOS) and ExoPlayer (Android) for pre-rendered audio playback, plus AVSpeechSynthesizer (iOS) and Android TextToSpeech for on-device synthesis.
- **TTS_Engine**: The on-device text-to-speech component used by Audio_Service to read Markdown narrative content when no pre-rendered audio file is provided.
- **Content_Bundle**: A self-contained, versioned set of files describing one route, including route geometry, POIs, narrative Markdown, optional pre-rendered audio, and a manifest.
- **POI**: Point of Interest. A geofenced narrative trigger anchored to a coordinate or polygon along a route.
- **Route**: An ordered sequence of POIs and transit stops mapped to a single transit line direction in the target city.
- **GTFS_Feed**: A General Transit Feed Specification dataset describing the city's transit stops, routes, and schedules.
- **Catalog_Service**: The self-hosted backend endpoint that publishes the list of available Content_Bundles and current versions.
- **Entitlement_Service**: The self-hosted backend endpoint that resolves what a given anonymous Device_Id is currently allowed to access (free tier, time pass, unlocked tokens, B2B grants).
- **Device_Id**: An anonymous, app-generated identifier persisted on the device, used for entitlement checks without requiring signup.
- **Offline_Pack**: The bundle of map tiles, route geometry, POI data, narrative Markdown, and optional audio files pre-downloaded over WiFi for offline use.
- **Authoring_Schema**: The strictly defined JSON and Markdown schema that all Content_Bundles must validate against.
- **Standby_Track**: Ambient or trivia audio content played when the main narrative is paused due to traffic or desync.
- **Dead_Reckoning**: Position estimation between known reference points using GTFS schedule and last known location when GPS is unavailable.
- **Route_Deviation**: A detected condition in which the user's trajectory no longer matches the active Route within configured tolerance.
- **Capability_Layer**: The runtime feature-flag and OS-capability detection layer that selects between newer and fallback native APIs.
- **Content_Key**: A per-Content_Bundle symmetric key used to encrypt protected assets (narrative Markdown and pre-rendered audio) at rest within an Offline_Pack.
- **Wrapping_Key**: A device-specific key derived from the Device_Id and a hardware-backed secret stored in iOS Keychain or Android Keystore, used to encrypt and decrypt the per-pack Content_Key.
- **License_Token**: A signed assertion issued by the Entitlement_Service that binds a Device_Id to a specific Content_Bundle id and version and carries a UTC expiry, required by the App in order to unwrap a Content_Key and decrypt protected assets.
- **Integrity_Signature**: The digital signature applied by the Catalog_Service to a pack's MANIFEST.lock.json file, covering every per-asset SHA-256 hash listed in the lock file so that tampering with the lock file or with any individual asset is detectable on the device.

## Requirements

### Requirement 1: Geofenced Transit Narration

**User Story:** As a traveler riding a regular city bus or tram, I want the app to narrate landmarks and architectural details as the vehicle passes them, so that I get a guided-tour experience without buying a commercial Hop-on Hop-off ticket.

#### Acceptance Criteria

1. THE App SHALL allow the user to start a tour by selecting an active Route from the installed Content_Bundles.
2. WHEN the user's filtered position enters the geofence of a POI on the active Route, THE Tour_Engine SHALL trigger the narrative segment associated with that POI.
3. WHILE a tour is active, THE Tour_Engine SHALL play at most one narrative segment at a time.
4. WHEN a narrative segment finishes playing, THE Tour_Engine SHALL mark the corresponding POI as consumed for the current tour session.
5. IF a POI has already been marked consumed in the current tour session, THEN THE Tour_Engine SHALL NOT replay the segment automatically when the user re-enters the same geofence.
6. WHERE a Route is configured with both major landmarks and mundane architectural details, THE Tour_Engine SHALL play segments of both categories according to their authored ordering and priority.
7. WHEN the user explicitly ends the tour, THE Tour_Engine SHALL stop audio playback and release location and audio resources within 2 seconds.

### Requirement 2: Standardized Authoring Schema for Routes and POIs

**User Story:** As a content author, I want a strictly defined JSON and Markdown file structure, so that I can add a new route by writing markdown in an AI model harness and dropping the output into the catalog.

#### Acceptance Criteria

1. THE Authoring_Schema SHALL define a Content_Bundle as a directory containing a manifest JSON file, a route JSON file, a POIs JSON file, and a narratives Markdown directory.
2. THE Authoring_Schema SHALL require each Content_Bundle manifest to declare bundle id, semantic version, target city, transit line reference, supported language codes, and minimum App version.
3. THE Authoring_Schema SHALL require each POI entry to declare a unique id, geofence geometry (point with radius or polygon), trigger direction filter, priority, category (landmark or architectural detail or trivia), language-keyed narrative file references, optional pre-rendered audio file references per language, and entitlement tier.
4. WHEN the App loads a Content_Bundle, THE App SHALL validate the bundle against the Authoring_Schema before activating it.
5. IF a Content_Bundle fails Authoring_Schema validation, THEN THE App SHALL refuse to activate the bundle and SHALL surface a human-readable error identifying the offending field.
6. THE Authoring_Schema SHALL allow narrative Markdown files to be added or edited without requiring changes to application source code.
7. THE Authoring_Schema SHALL support multi-language POI content by keying narrative and audio asset references on ISO 639-1 language codes.

### Requirement 3: Offline-First Operation

**User Story:** As a traveler on a transit vehicle with unreliable cellular coverage, I want the entire tour to work without a data connection, so that I am not interrupted by signal loss.

#### Acceptance Criteria

1. WHEN the user downloads an Offline_Pack over WiFi, THE App SHALL persist map vector tiles, route geometry, POI data, narrative Markdown, and any pre-rendered audio for that Route to local storage.
2. WHILE a tour is active, THE App SHALL serve all map rendering, geofence evaluation, narrative text, and audio playback from local storage without issuing cellular network requests.
3. IF the device is offline at tour start, THEN THE App SHALL still allow the user to start any tour whose Offline_Pack is fully downloaded and validated.
4. WHEN an Offline_Pack download is interrupted, THE App SHALL resume the download from the last completed asset on the next WiFi-connected attempt.
5. IF an Offline_Pack is partially downloaded, THEN THE App SHALL prevent the user from starting a tour for that Route until the pack is complete and SHALL display the missing-asset count.
6. WHERE a network connection is unmetered and available, THE App SHALL check for Content_Bundle updates against the Catalog_Service and notify the user of available updates without auto-downloading on metered connections.

### Requirement 4: Open-Source Map and Geolocation Stack

**User Story:** As the product owner, I want the app to avoid commercial map and geolocation API fees, so that total cost of ownership stays low at scale.

#### Acceptance Criteria

1. THE App SHALL render maps using MapLibre GL Native with OpenStreetMap-derived vector tiles.
2. THE App SHALL source transit stop, route, and schedule data from GTFS_Feed datasets.
3. WHERE routing or stop-time queries beyond static GTFS are required, THE App SHALL use OpenTripPlanner or an equivalent open-source service.
4. THE App SHALL NOT include any runtime dependency on Google Maps Platform, Apple MapKit tile services, Mapbox commercial tiles, or other paid map or geocoding APIs for map rendering or geofencing.
5. THE App SHALL display attribution for OpenStreetMap, MapLibre, and any Creative Commons content used in narratives, in accordance with their license terms.

### Requirement 5: GPS Noise and Urban Canyon Resilience

**User Story:** As a traveler in a dense city center, I want the app to ignore obvious GPS errors, so that narratives do not trigger for landmarks I am not actually near.

#### Acceptance Criteria

1. WHEN the Location_Service receives a position update, THE Location_Service SHALL discard the update if its reported horizontal accuracy is worse than 50 meters.
2. WHEN consecutive position updates imply a ground speed greater than 120 km/h on a transit Route, THE Location_Service SHALL classify the newer update as a spike and exclude it from geofence evaluation.
3. WHEN a candidate POI trigger is evaluated, THE Tour_Engine SHALL require the user's filtered position to remain inside the geofence for a configurable dwell time of at least 3 seconds before firing the trigger.
4. IF a POI has a direction filter and the user's recent heading along the Route does not match the filter, THEN THE Tour_Engine SHALL NOT fire the trigger.
5. WHILE the App is running a tour, THE Location_Service SHALL maintain a smoothed position estimate using at least the last 3 accepted updates.

### Requirement 6: Tunnel and Signal-Loss Dead Reckoning

**User Story:** As a traveler whose tram passes through a tunnel, I want the narrative to keep up with my real position when the GPS is lost, so that I do not miss segments when signal returns.

#### Acceptance Criteria

1. WHEN the Location_Service has not produced an accepted position update for 15 seconds during an active tour, THE Tour_Engine SHALL enter Dead_Reckoning mode.
2. WHILE in Dead_Reckoning mode, THE Tour_Engine SHALL estimate the vehicle's position along the Route using the last known position, the GTFS_Feed schedule for the active transit line, and elapsed time.
3. WHILE in Dead_Reckoning mode, THE Tour_Engine SHALL only fire POI triggers whose authoring metadata permits schedule-based activation.
4. WHEN an accepted GPS position update returns after Dead_Reckoning, THE Tour_Engine SHALL reconcile the estimated position with the new update and resume normal geofence evaluation.
5. IF the reconciled position indicates that one or more POIs were passed during signal loss and those POIs permit deferred playback, THEN THE Tour_Engine SHALL play the highest-priority missed segment and mark the others as skipped.

### Requirement 7: Narrative Desync and Standby Content

**User Story:** As a traveler whose bus is stuck in traffic, I want the app to fill the silence with related trivia instead of replaying the next landmark too early, so that the experience stays engaging.

#### Acceptance Criteria

1. WHEN the smoothed ground speed remains below 3 km/h for 30 seconds during an active tour and no POI segment is currently playing, THE Tour_Engine SHALL begin playing a Standby_Track from the active Content_Bundle.
2. WHILE a Standby_Track is playing, THE Tour_Engine SHALL pause the Standby_Track within 1 second of detecting either resumed motion or entry into a new POI geofence.
3. WHEN a POI segment is triggered while a Standby_Track is playing, THE Tour_Engine SHALL stop the Standby_Track before starting the POI segment.
4. IF no Standby_Track is available in the active Content_Bundle, THEN THE Tour_Engine SHALL remain silent during desync rather than repeating prior POI segments.

### Requirement 8: Route Deviation Detection

**User Story:** As a traveler who gets off the bus early or transfers to a different line, I want the app to notice and stop narrating, so that I am not fed irrelevant content.

#### Acceptance Criteria

1. WHEN the user's smoothed position remains more than 150 meters from the active Route polyline for 60 continuous seconds, THE Tour_Engine SHALL classify the session as Route_Deviation.
2. WHEN Route_Deviation is classified, THE Tour_Engine SHALL pause narrative playback and present an in-app prompt offering to resume the same Route, switch to a different Route, or end the tour.
3. WHILE awaiting the user's response to a Route_Deviation prompt, THE Tour_Engine SHALL NOT fire new POI triggers.
4. WHEN the user chooses to resume the original Route and the smoothed position returns within 75 meters of the Route polyline, THE Tour_Engine SHALL resume normal geofence evaluation.
5. IF the user does not respond to the Route_Deviation prompt within 5 minutes, THEN THE Tour_Engine SHALL end the tour and release location and audio resources.

### Requirement 9: Hybrid Narration (TTS and Pre-Rendered Audio)

**User Story:** As a content author, I want most segments to be auto-narrated from Markdown by on-device TTS while hero landmarks use pre-rendered audio, so that I can scale content without a studio for every POI.

#### Acceptance Criteria

1. WHEN a POI trigger fires and the POI declares a pre-rendered audio asset for the user's selected language, THE Audio_Service SHALL play that audio asset.
2. WHEN a POI trigger fires and the POI declares no pre-rendered audio asset for the user's selected language, THE Audio_Service SHALL render the corresponding narrative Markdown using the TTS_Engine in that language.
3. THE Audio_Service SHALL apply consistent volume normalization across pre-rendered audio and TTS output within ±3 dB.
4. IF the requested TTS voice is not installed on the device, THEN THE Audio_Service SHALL fall back to the platform default voice for the requested language and SHALL log a non-fatal warning.
5. WHERE the user has selected a language not present in a POI's narrative references, THE Tour_Engine SHALL fall back to the Content_Bundle's declared default language for that POI.

### Requirement 10: Audio Focus and Interruption Handling

**User Story:** As a traveler whose phone rings during a tour, I want the narration to pause for the call and resume cleanly afterward, so that I do not lose my place.

#### Acceptance Criteria

1. WHEN the OS reports an audio focus loss event during playback, THE Audio_Service SHALL pause the current segment and record its playback offset within 500 milliseconds.
2. WHEN the OS reports audio focus regained after a pause caused by focus loss, THE Audio_Service SHALL resume the paused segment from the recorded offset.
3. IF audio focus is lost for more than 10 minutes, THEN THE Audio_Service SHALL discard the paused segment offset and SHALL NOT auto-resume on focus regain.
4. WHEN a navigation prompt or other transient ducking event is reported, THE Audio_Service SHALL lower its output volume by at least 50% for the duration of the ducking event and SHALL restore volume on event end.

### Requirement 11: Battery-Disciplined Location Polling

**User Story:** As a traveler using the app for a multi-hour tour, I want the app to avoid draining my battery, so that my phone still works when I arrive.

#### Acceptance Criteria

1. WHILE no tour is active, THE Location_Service SHALL NOT request continuous high-accuracy location updates.
2. WHEN a tour is active, THE Location_Service SHALL prefer OS-native region monitoring (CoreLocation regions on iOS, GeofencingClient on Android) for POI proximity detection over continuous polling.
3. WHERE high-accuracy fixes are required for desync detection or dead-reckoning reconciliation, THE Location_Service SHALL request foreground high-accuracy updates only for the duration of the reconciliation window.
4. WHILE the App is in the background during an active tour, THE Location_Service SHALL use significant-location-change updates on iOS and balanced-power priority on Android except during active POI approach windows.
5. THE App SHALL expose a user-visible indicator while high-accuracy location updates are in use.

### Requirement 12: Background Execution and OS Limits

**User Story:** As a traveler who locks the screen during the ride, I want the app to keep narrating in the background without being killed by the OS, so that I do not miss segments.

#### Acceptance Criteria

1. WHEN a tour is active and the App moves to the background, THE App SHALL maintain audio playback using the platform's background audio capability.
2. WHEN a tour is active and the App moves to the background, THE Location_Service SHALL continue to deliver geofence events using OS-native region monitoring on iOS and foreground service with GeofencingClient on Android.
3. IF the OS suspends the App while a tour is active, THEN THE Location_Service SHALL rely on OS-delivered geofence wake events to resume the Tour_Engine and SHALL replay any deferred POI per Requirement 6 reconciliation rules.
4. THE App SHALL declare and request only the background modes and runtime permissions required to satisfy active-tour functionality, and SHALL document each in the platform manifests.

### Requirement 13: Anonymous Identity and Entitlements

**User Story:** As a first-time user, I want to start a tour without creating an account, so that there is zero signup friction.

#### Acceptance Criteria

1. WHEN the App is launched for the first time on a device, THE App SHALL generate a Device_Id and persist the Device_Id in secure local storage.
2. WHEN the App needs to determine access to a Route, premium tier, time pass, or unlocked content, THE App SHALL query the Entitlement_Service using the Device_Id.
3. IF the Entitlement_Service is unreachable and a cached entitlement exists, THEN THE App SHALL honor the cached entitlement until its declared expiry.
4. WHEN a user completes a purchase through the platform store, THE App SHALL submit the platform receipt to the Entitlement_Service for validation and SHALL update the local entitlement cache on success.
5. WHEN the user requests purchase restore, THE App SHALL re-query the Entitlement_Service using the Device_Id and platform store receipts and SHALL update the local entitlement cache.
6. THE App SHALL NOT require email, phone number, or third-party social login to start or complete a tour.

### Requirement 14: Monetization-Ready Data Flow

**User Story:** As the product owner, I want the runtime data model to already encode monetization gates, so that we can ship freemium, time passes, token unlocks, and B2B narratives without re-architecting.

#### Acceptance Criteria

1. THE Authoring_Schema SHALL allow each POI and each narrative layer to declare an entitlement tier from the set {free, time_pass, token_unlock, b2b}.
2. WHEN the Tour_Engine evaluates whether to play a narrative segment, THE Tour_Engine SHALL consult the current cached entitlement set for the Device_Id and SHALL skip or substitute segments whose tier is not granted.
3. WHERE a time pass entitlement is active, THE Entitlement_Service SHALL expose a UTC expiry timestamp and THE App SHALL stop honoring the entitlement after that timestamp.
4. WHERE a token unlock applies to a specific deeper trivia layer of a POI, THE Tour_Engine SHALL play the deeper layer in addition to the base segment when the user is within the POI geofence and the token is granted.
5. WHERE a B2B micro-narrative is configured, THE Authoring_Schema SHALL require the segment to declare a sponsor identifier and a disclosure string, and THE App SHALL display or speak the disclosure before the sponsored content plays.
6. THE App SHALL provide a moderation flag in the Authoring_Schema that allows the Catalog_Service to disable a B2B segment remotely without republishing the Content_Bundle.

### Requirement 15: Native API Preference and Capability Layer

**User Story:** As an engineer, I want the app to use native OS capabilities through thin React Native turbo modules and to opt into newer APIs as they ship, so that the experience feels native and improves over time without forks.

#### Acceptance Criteria

1. THE App SHALL implement Location_Service, Audio_Service, and TTS_Engine as React Native turbo modules wrapping the platform-native APIs declared in the Glossary.
2. THE Capability_Layer SHALL detect the OS version and available native APIs at runtime and SHALL expose feature flags consumable by the Tour_Engine.
3. WHEN a newer OS API declared in the Capability_Layer is available, THE Tour_Engine SHALL use the newer API path.
4. IF a declared newer OS API is not available on the running OS version, THEN THE Tour_Engine SHALL fall back to the documented legacy API path without degrading active-tour functionality below the requirements in this document.

### Requirement 16: Accessibility

**User Story:** As a user who relies on assistive technology, I want the app to work with VoiceOver and TalkBack and to caption audio narration, so that the tour is usable for me.

#### Acceptance Criteria

1. THE App SHALL expose all interactive UI elements with accessible labels compatible with iOS VoiceOver and Android TalkBack.
2. WHEN a narrative segment plays, THE App SHALL display the corresponding narrative text on screen as a caption synchronized with audio playback.
3. WHERE a pre-rendered audio file is used, THE Authoring_Schema SHALL require an accompanying transcript Markdown file in the same language.
4. THE App SHALL allow the user to adjust narration playback speed in at least 0.25x increments between 0.75x and 1.5x.
5. THE App SHALL respect the OS-level dynamic type or font scale setting in all narrative and UI text rendering.

### Requirement 17: Content Licensing and Attribution

**User Story:** As the product owner, I want the app to comply with OpenStreetMap and Creative Commons licensing, so that we are legally clear to ship.

#### Acceptance Criteria

1. THE App SHALL display an attribution screen accessible from the main menu listing OpenStreetMap, MapLibre, and any Creative Commons sources used.
2. WHERE a narrative segment incorporates Creative Commons content, THE Authoring_Schema SHALL require a license identifier and an attribution string in the POI metadata.
3. WHEN a POI segment requires attribution, THE App SHALL render the attribution string visibly during or immediately after the segment's playback.
4. THE App SHALL include OpenStreetMap attribution on every map view in accordance with the OpenStreetMap attribution guidelines.

### Requirement 18: GTFS Feed Freshness

**User Story:** As an operator of the catalog, I want the app to use up-to-date GTFS data and to flag stale data, so that schedule-based features stay accurate.

#### Acceptance Criteria

1. THE Catalog_Service SHALL publish a GTFS_Feed version timestamp for each supported city.
2. WHEN the App is on an unmetered connection and a newer GTFS_Feed is available, THE App SHALL download the updated feed and replace the local copy atomically.
3. IF the local GTFS_Feed for the active city is older than 30 days, THEN THE App SHALL display a non-blocking warning that schedule-based features may be inaccurate.
4. IF the local GTFS_Feed for the active city is older than 90 days, THEN THE App SHALL disable Dead_Reckoning mode and SHALL inform the user that tunnel and signal-loss handling is degraded.

### Requirement 19: Storage Budget and Eviction

**User Story:** As a user with limited phone storage, I want the app to manage offline content within a budget, so that it does not silently fill up my device.

#### Acceptance Criteria

1. THE App SHALL allow the user to configure a maximum storage budget for Offline_Packs, with a default ceiling of 2 GB.
2. WHEN downloading a new Offline_Pack would exceed the configured storage budget, THE App SHALL prompt the user to either raise the budget or select Offline_Packs to remove.
3. WHEN the user has enabled automatic eviction and a new Offline_Pack download would exceed the budget, THE App SHALL evict the least-recently-used Offline_Pack first until the budget is satisfied.
4. THE App SHALL never evict an Offline_Pack whose Route is currently active in a tour session.
5. THE App SHALL display total Offline_Pack storage used and remaining budget on the storage management screen.

### Requirement 20: B2B Micro-Narrative Disclosure and Moderation

**User Story:** As a regulator-conscious product owner, I want B2B sponsored micro-narratives to be clearly disclosed and remotely moderable, so that we meet advertising disclosure norms.

#### Acceptance Criteria

1. WHEN a sponsored B2B segment is about to play, THE App SHALL render a visible "Sponsored" indicator and SHALL play or display the authored disclosure string before the segment content begins.
2. WHILE a sponsored B2B segment is playing, THE App SHALL keep the "Sponsored" indicator visible.
3. WHEN the Catalog_Service marks a B2B segment as disabled, THE App SHALL refresh the moderation state on next Catalog_Service contact and SHALL skip that segment on subsequent triggers.
4. IF a sponsored B2B segment lacks a disclosure string in the Authoring_Schema, THEN THE App SHALL refuse to play that segment and SHALL log a content validation error.

### Requirement 21: At-Rest Encryption with Per-Device Key Wrapping

**User Story:** As the product owner, I want narrative and audio assets to be encrypted on disk and bound to the device that downloaded them, so that casually copying a pack directory to another device does not yield usable content.

#### Acceptance Criteria

1. THE App SHALL encrypt narrative Markdown files and pre-rendered audio assets at rest within an Offline_Pack using a per-pack Content_Key.
2. THE App SHALL NOT encrypt vector map tile files within an Offline_Pack, since the underlying OpenStreetMap data is publicly licensed.
3. THE App SHALL wrap each per-pack Content_Key with a Wrapping_Key that is derived from the Device_Id combined with a hardware-backed secret stored in iOS Keychain on iOS and in Android Keystore on Android.
4. WHERE the Capability_Layer reports availability of Secure Enclave on iOS or StrongBox-backed Keystore on Android, THE App SHALL store the hardware-backed secret in that secure element.
5. IF a pack directory is copied byte-for-byte to a different device, THEN unwrapping of the per-pack Content_Key on that device SHALL fail because the Wrapping_Key derivation depends on the original device's hardware-backed secret.
6. WHEN a narrative or audio asset is required for playback, THE Audio_Service SHALL decrypt the asset into memory only at playback time.
7. THE App SHALL NOT persist decrypted plaintext of narrative Markdown or pre-rendered audio assets to the filesystem.
8. THE App SHALL apply key derivation path obfuscation in the binary as a defense-in-depth measure against trivial static analysis.

### Requirement 22: Signed License Tokens for Decryption Authorization

**User Story:** As the product owner, I want decryption to require a fresh, signed license bound to this device and bundle, so that revocation and time-pass expiry are enforced even on devices that download a pack once and then go fully offline.

#### Acceptance Criteria

1. THE Entitlement_Service SHALL issue a signed License_Token that binds a Device_Id to a specific Content_Bundle id and version and that carries a UTC expiry timestamp.
2. WHEN the App attempts to unwrap a per-pack Content_Key for playback, THE App SHALL require a valid, unexpired License_Token that covers the bundle id and version of the pack.
3. IF no valid unexpired License_Token is available for a pack, THEN THE App SHALL refuse to decrypt that pack's protected assets and SHALL surface an entitlement error to the user.
4. THE Entitlement_Service SHALL issue License_Tokens with an offline validity window of at least 14 days from issuance, so that multi-day fully-offline trips remain playable.
5. WHEN the device has an unmetered connection and a current License_Token is within 3 days of expiry, THE App SHALL refresh the License_Token in the background.
6. WHEN the App refreshes a License_Token, THE App SHALL verify the token signature against the embedded Entitlement_Service public key before storing the token in the local cache.
7. IF a License_Token signature does not verify against the embedded public key, THEN THE App SHALL discard the token and SHALL refuse to decrypt the corresponding pack's protected assets.

### Requirement 23: Pack Integrity Verification and Tamper Detection

**User Story:** As the product owner, I want the app to detect tampered or hand-crafted packs and to flag jailbroken or rooted devices for telemetry, so that casual repackaging attacks fail and we have signal on the install base, without penalizing legitimate users.

#### Acceptance Criteria

1. THE Catalog_Service SHALL sign each pack's MANIFEST.lock.json file with the catalog signing key, producing an Integrity_Signature whose payload covers every per-asset SHA-256 hash listed in that lock file.
2. WHEN the App loads an Offline_Pack, THE App SHALL verify the Integrity_Signature on MANIFEST.lock.json against the embedded catalog public key before activating the pack.
3. IF the Integrity_Signature on MANIFEST.lock.json does not verify against the embedded catalog public key, THEN THE App SHALL refuse to load the pack and SHALL surface a content integrity error.
4. WHEN the App computes a per-asset SHA-256 hash and that hash does not match the value covered by the Integrity_Signature in MANIFEST.lock.json, THE App SHALL refuse to decrypt or play that asset and SHALL surface a content integrity error.
5. WHEN the App is launched, THE App SHALL run a rooted-or-jailbroken device detection probe and SHALL log the result as a telemetry signal.
6. THE App SHALL continue to deliver narrative playback, captions, and accessibility features on rooted or jailbroken devices, since blocking would penalize legitimate users including users who have rooted their device for accessibility customization.

### Requirement 24: Branding and Identity Layer

**User Story:** As the product owner, I want all brand references centralized in one module so that a future rename requires minimal code changes.

#### Acceptance Criteria

1. THE App SHALL expose all user-facing brand strings (display name, support URL, primary domain, deep-link scheme, bundle identifier) through a single branding module so that changing the brand requires editing one source location.
2. WHEN the App computes the Wrapping_Key per Requirement 21, THE App SHALL use the HKDF info parameter value "tramio/v1/wrap".
3. THE Authoring_Schema SHALL use schema URIs under the domain "schema.tramio.app".
4. WHEN the App resolves the Catalog_Service or Entitlement_Service base URL, THE App SHALL read the URL from runtime configuration so that the primary domain can be changed without rebuilding non-config source code.
5. THE App SHALL declare its iOS bundle identifier and Android application ID in platform manifests under the namespace "app.tramio.client" for production builds and "app.tramio.client.dev" for development builds.
6. THE App SHALL display the brand name "Tramio" in the app launcher, About screen, and store listings.
