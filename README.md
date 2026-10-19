# FamilyShield

Personal-safety Android app: a dark, purple-accented WebView shell over a small
self-hosted Node backend. One tap raises an alert to your family, and — if you opt
in — to verified helpers who are physically nearby.

Five tabs stay fixed: **Check · Guide · Family · History · Settings**.

---

## Repository layout

```
app/                     Android host (no Gradle; built by tools/build_apk.py)
  AndroidManifest.xml    four permissions, all runtime-guarded
  java/com/familyshield/app/MainActivity.java
  res/                   themes, strings, launcher icons, network_security_config
  assets/www/            the entire UI (plain HTML/CSS/ES5 JS — no bundler)
    index.html
    css/                 app.css + theme
    js/                  app, engine, geo, cloud, sos, helper, i18n(+base,+te)
server/                  Node >= 22.5 backend, zero runtime dependencies
  index.js               HTTP entry point (routing, CORS, security headers)
  auth.js  family.js  emergency.js  providers.js
  db.js  config.js  util.js  http.js
  test/api.test.js       node:test suite (17 tests)
docs/
  CONTRACTS.md           single source of truth for the client⇄server contract
  API.md                 endpoint reference
  I18N_KEYS.md           translation key inventory
tools/
  build_apk.py           aapt2 → javac → d8 → zipalign → apksigner
keystore/                debug signing material for local builds
```

---

## Run the backend

```powershell
cd server
node index.js                       # http://127.0.0.1:8787
```

Development convenience (never for production):

```powershell
$env:FS_DEV_MODE = "1"              # OTP codes are logged instead of sent
$env:FS_PORT = "8787"
node index.js
```

With `FS_DEV_MODE=1` the console prints `[otp] <phone> code <6 digits>` and the API
returns `delivery.status: "logged"`. Outside dev mode every SMS channel that is not
configured answers **`503 provider_not_configured`** — the app surfaces that honestly
rather than pretending a code was sent.

### Configuration

All configuration is environment based (`server/config.js`); nothing secret is in
source. Copy the template:

```powershell
copy server\.env.example server\.env
node --env-file=server\.env server\index.js
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `FS_PORT` / `FS_HOST` | `8787` / `0.0.0.0` | Listen address |
| `FS_DATA_DIR` | `server/data` | SQLite file + dev secret location |
| `FS_TOKEN_SECRET` | generated once | HMAC key for bearer tokens |
| `FS_DEV_MODE` | `0` | Log OTP codes, allow loopback HTTP |
| `FS_OTP_PROVIDER` | `none` | `twilio` to send real SMS |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | — | Twilio credentials |
| `FS_PUSH_PROVIDER` | `none` | `fcm` to send real push |
| `FS_FCM_SERVICE_ACCOUNT` | — | Path to the Firebase service-account JSON |
| `FS_NEARBY_RADIUS_M` | `2000` | **Single source of truth** for helper matching |
| `FS_NEARBY_MAX_HELPERS` | `5` | Helpers notified per alert |
| `FS_EMERGENCY_TTL_SECONDS` | `1800` | Alert lifetime before auto-expiry |
| `FS_EMERGENCY_RATE_LIMIT` / `..._WINDOW` | `3` / `1800` | Abuse protection |
| `FS_FAMILY_INVITE_RATE_LIMIT` | `20` | Invitation flood guard |
| `FS_WEBHOOK_URL` / `FS_WEBHOOK_SECRET` | — | Optional per-alert webhook |

`FS_NEARBY_RADIUS_M` is read only in `server/config.js`; the client never holds a
copy, so a radius change needs a backend restart and nothing else.

### Tests

```powershell
node --test server\test\api.test.js
```

The suite covers OTP request/verify/rate limits, mutual family consent, blocked
pairs, emergency creation with honest delivery states, idempotency, cancel, helper
opt-in gating, and report acceptance. It uses a temporary data directory and never
touches real providers.

---

## Run the UI

Any static server over `app/assets/www` works:

```powershell
python -m http.server 5500 -d app\assets\www
# then open http://127.0.0.1:5500
```

On desktop the app runs in **local mode**: the scanner, guide, history and settings
work fully offline, and network-only features (sign-in, family sync, SOS delivery)
report "backend not configured" instead of faking success. Point the app at a backend
from **Settings → Family account**, or on device via
`window.FSAndroid.setBackendOrigin("https://your.host")`.

`js/geo.js` adapts the native one-shot location channel
(`FSAndroid.requestLocation` → `window.FS.nativeLocation`) into the standard
`navigator.geolocation` API, so SOS and Nearby Helper use ordinary web code.

---

## Build the APK

```powershell
python tools\build_apk.py                 # SDK auto-detected, output in dist/
python tools\build_apk.py --sdk C:\Android\sdk --out dist
```

Requires the Android SDK (`build-tools`, one `platforms/android-34`) and a JDK. The
APK is signed with the debug key in `keystore/`; replace it before publishing.

Permissions declared: `INTERNET`, `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`,
`POST_NOTIFICATIONS` — each requested at runtime, each tied to a user action. No
camera, contacts, SMS, background location, or gallery access.

---

## Safety rules the code must keep

- **Never fake delivery.** Auth, SOS, helper acceptance and reports always reflect a
  real backend response. `delivery.status` is exactly what the server returned.
- **Consent is explicit and mutual.** A connection exists only after the other person
  accepts; a phone number alone never grants access to anyone's data.
- **One tap, no interrogation.** SOS never asks the user to pick an emergency type or
  answer a questionnaire before sending. There is a ~5 s cancel window, then it goes.
- **Helpers are opt-in volunteers.** Publishing a location requires the opt-in flag,
  and only an authenticated helper can accept or decline.
- **No medical claims.** The app shares what the user asks it to share; it never
  diagnoses a condition.
- **Localisation is complete.** English, Hindi and Telugu ship with every string —
  see `docs/I18N_KEYS.md` and `js/i18n.js`.

---

## Known gap: screenshot OCR

The scam checker accepts typed text, text shared into the app from another app,
and text extracted from a screenshot — but **screenshot OCR is capability-gated,
and the current APK does not include an OCR engine.** `js/cloud.js` renders the
"Scan a screenshot" card only when the native bridge actually exposes
`pickScreenshotForOcr` / `ocrImageFile`, so on the shipped build the card is
absent rather than silently failing. Nothing in the app fakes recognition.

Adding real on-device OCR means shipping an engine inside the APK. The build in
`tools/build_apk.py` is a `javac` → `d8` → `aapt2` pipeline with no Gradle
dependency resolution, so ML Kit (bundled `com.google.mlkit:text-recognition`
plus its `play-services-tasks` / `mlkit-common` / JNI libraries and AAR
resources) cannot be pulled in without first teaching the build to resolve and
merge AARs. Until that happens, the supported manual paths are: type the message,
share text from the messaging app into FamilyShield, or paste the text yourself.

---

## Known gap: background push delivery

The server half of FCM is complete and honest: `server/providers.js` signs a
service-account JWT (RS256, no `firebase-admin` dependency), posts to the FCM v1
endpoint, records every attempt, retries `UNAVAILABLE`/`INTERNAL`, and prunes
tokens that come back `UNREGISTERED`/`INVALID_ARGUMENT`. Tokens are registered
against the authenticated user by `POST /v1/devices`, and `push.js` registers on
sign-in and session restore, refreshes the token, and drops it on logout.

**The APK cannot yet receive those notifications.** The build in
`tools/build_apk.py` compiles against a single `android.jar` with no Gradle
dependency resolution, so the Firebase SDK (`firebase-messaging` and its
`play-services-basement` / `firebase-common` / `firebase-iid` AARs) is not on the
classpath and no `google-services.json` is merged. `MainActivity.showNotification`
handles tapping notifications that arrive through channels the app already owns;
it does not create an FCM token.

Consequence, stated plainly: with `FS_PUSH_PROVIDER=fcm` the server really sends
and really reports acceptance — but a stock APK built by this repo will not
receive it. Family and helper alerts currently land only for devices whose
browser tab or WebView is already open (the foreground poll in `js/push.js`).

To make background delivery operational, one of these is required:

1. **Add Firebase to the build.** Introduce a Gradle-based Android module (or
   extend `tools/build_apk.py` to resolve and merge the Firebase AARs), declare
   `com.google.firebase:firebase-messaging`, add `google-services.json` for the
   package `com.familyshield.app`, and implement
   `FirebaseMessagingService.onNewToken` → store the token for the bridge to read.
   `push.js` already consumes whatever `FSAndroid.getFcmToken()` returns.
2. **Use a Web-Push channel** for installs that are PWAs rather than APKs.

Server environment for FCM:

| Variable | Value |
| --- | --- |
| `FS_PUSH_PROVIDER` | `fcm` |
| `FS_FCM_SERVICE_ACCOUNT` | path to the service-account JSON (**server only — never in the APK or the repo**) |
| `FS_FCM_PROJECT_ID` | optional override; otherwise read from the service-account file |

Without `FS_PUSH_PROVIDER=fcm` the API returns `status: "unsupported"` and the UI
says so, instead of pretending an alert went out.

---

## Documentation

- `docs/CONTRACTS.md` — canonical request/response shapes and status strings. Change
  a field or state here first, then both sides.
- `docs/API.md` — endpoint-by-endpoint reference.
- `docs/I18N_KEYS.md` — translation key inventory.
