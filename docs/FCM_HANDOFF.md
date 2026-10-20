# FamilyShield — FCM Work Handoff

**Trigger phrase to resume:** `Resume FamilyShield FCM — read docs/FCM_HANDOFF.md`

Last worked: **2026-10-20**. Previous pass was 2026-10-19.

## Honest status

The commit `c424a1f` titled "native FCM integration" was inaccurate: the APK contained no
`firebase-messaging` classes. As of 2026-10-20 that is fixed in the build itself — the packaged
APK contains the Firebase Messaging SDK, the app's receiver service, and the FCM permissions.

What is **still not true**: nothing has been exercised against a real Firebase project or a real
handset, because `google-services.json` and the server service-account file do not exist yet.
Push is *shipped but unconfigured*. Do not describe background notifications as working until the
physical-device checklist at the bottom has actually been run.

## What exists now

Pipeline: `tools/fetch_firebase_deps.py` → `.deps/firebase/` (AARs resolved from Maven Central via
`.deps/firebase/closure.json`, plus their bundled `AndroidManifest.xml` and `res/`) →
`tools/build_apk.py` (aapt2 resource compile, manifest merge across 41 AAR manifests, javac
against `android.jar` + 64 jars, d8, zipalign, apksigner).

- `app/java/com/familyshield/app/FsMessagingService.java` — `FirebaseMessagingService` subclass,
  `onNewToken` + `onMessageReceived`; validates `type`/id pairs before anything leaves the service.
- `app/java/com/familyshield/app/FsPush.java` — token cache (`fs_push` prefs, token + owning user),
  channel creation, neutral lock-screen text, validated `EXTRA_TARGET`, `canNotify()` for API 33+.
- `app/java/com/familyshield/app/MainActivity.java` — `getFcmToken()` / `clearFcmTokenUser()`
  bridge methods, `POST_NOTIFICATIONS` request, `onNewIntent` hand-off into the existing
  `openTarget()` router (the routing fix is untouched).
- `app/AndroidManifest.xml` — `<service FsMessagingService>` with the `MESSAGING_EVENT` filter
  (`exported=false`) and the SDK's default channel/icon metadata.
- Server side (pre-existing, unchanged apart from tests): RS256 service-account JWT → OAuth token
  cache → FCM HTTP v1 `messages:send`, single retry on 429/5xx, one `notifications` ledger row per
  device, `provider_not_configured` when no credentials. Never claims `read`.
- `server/test/fcm.test.js` — new: token registration validation, ownership on unregister,
  payload shape, dead-token pruning, 403 reporting, unconfigured-provider behaviour.

## Verified on 2026-10-20 (evidence, not intent)

- `python tools/build_apk.py` → OK, `dist/FamilyShield-1.6.apk`, 3,803,264 bytes, v2+v3 signed.
  Package `com.familyshield.app`, versionCode 7, versionName 1.6, minSdk 24, targetSdk 34.
  Resolved Firebase stack at build time: firebase-messaging **26.0.0**, firebase-common 23.0.0,
  play-services-base/basement 18.9.0. `dist/FamilyShield-1.5.apk` is kept as the previous
  known-good artifact.
- `aapt2 dump badging` on 1.6: permissions are INTERNET, COARSE+FINE_LOCATION,
  POST_NOTIFICATIONS, ACCESS_NETWORK_STATE, WAKE_LOCK, c2dm RECEIVE and the app's own
  DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION — no SMS, camera, or storage permissions.
- Build log: manifest merged 41 AAR manifests, added `com.google.android.c2dm.permission.RECEIVE`,
  `ACCESS_NETWORK_STATE`, `WAKE_LOCK`; `dex verified 2 firebase-messaging class(es) in classes.dex`.
- `aapt2 dump xmltree` on the *packaged* APK: `com.familyshield.app.FsMessagingService` with
  `com.google.firebase.MESSAGING_EVENT`, both `default_notification_*` metadata,
  `POST_NOTIFICATIONS`, package `com.familyshield.app`.
- `cd server && npm test` → 29 tests, 29 pass, 0 fail.
- Build prints `firebase UNCONFIGURED: ... cannot initialise without google-services.json`.

## Tomorrow's mission (in order)

1. Create the Firebase Android app for `com.familyshield.app` and drop
   `google-services.json` into `app/google-services.json` (already gitignored). Rerun the build;
   the `firebase UNCONFIGURED` line must disappear and `build/resources` must show
   `google_app_id`.
2. Put the service-account JSON outside the repo, set `FS_PUSH_PROVIDER=fcm`,
   `FS_FCM_SERVICE_ACCOUNT=<path>`, `FS_FCM_PROJECT_ID=<id>` on the server only.
3. On a handset: install the APK, log in, confirm `getFcmToken()` returns a token and
   `POST /v1/devices` returns 204, and confirm the `devices` row carries the right user.
4. Background test: second handset triggers a family emergency; first handset with FamilyShield
   backgrounded must show the alert; tap must land on that emergency, not the home screen.
5. Foreground test: alert appears in-app, no duplicate tray entry.
6. Token refresh: clear app data / reinstall, confirm the new token replaces the old row and the
   old one is pruned rather than left to fail forever.

## Do not

- Do not claim the APK receives push until item 3+4 above were run on a real device.
- Do not embed service-account credentials in the APK or commit secrets.
- Do not treat an FCM API 200 as proof the user received or read the alert.
- Do not gate the emergency screens on Firebase being configured — `FsPush` degrades to an empty
  token by design.
