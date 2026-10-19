# FamilyShield API contract (v1) — frozen

Single source of truth for the backend (`server/`) and the client (`js/api.js`, `js/account.js`,
`js/emergency.js`). Do not change a field name or status string without updating this file.

Transport: HTTPS in production. JSON request/response, `Content-Type: application/json`.
Base path `/v1`. Auth: `Authorization: Bearer <token>`.
CORS: `Access-Control-Allow-Origin: *` (WebView `file://` origin is `null`), allow
`Authorization, Content-Type, Idempotency-Key`, methods `GET,POST,PATCH,DELETE,OPTIONS`.

Phone numbers are normalised to E.164 (`+919876543210`). Invalid numbers → `400 {error:"invalid_phone"}`.

## Errors

Every error is `{ "error": "<code>", "message": "<short english>" , "retryAfterSeconds": n? }`.

| HTTP | code | meaning |
|---|---|---|
| 400 | `invalid_phone`, `invalid_code`, `invalid_body`, `invalid_location` | bad input |
| 401 | `unauthorized` | missing/expired token |
| 403 | `forbidden`, `not_opted_in`, `not_eligible` | server-side authorization failed |
| 404 | `not_found` | unknown id, or not visible to caller |
| 409 | `already_requested`, `already_connected`, `state_conflict`, `already_claimed` | raced/duplicate |
| 429 | `rate_limited` | includes `retryAfterSeconds` |
| 503 | `provider_not_configured` | OTP/push provider missing — never faked |
| 500 | `internal` | unexpected |

The client must never treat a 2xx as proof of delivery: delivery status lives in the payload.

## 1. Auth

### POST /v1/auth/otp/request
`{ "phone": "+919876543210" }` → `202`
```json
{ "challengeId": "uuid", "expiresInSeconds": 300,
  "delivery": { "channel": "sms", "status": "sent" | "provider_not_configured" | "failed" } }
```
- OTP stored only as `HMAC-SHA256(secret, challengeId + ":" + code)`; never logged, never returned.
- Rate limits: 3 requests / 10 min / phone, 10 / 10 min / IP → `429`.
- If no SMS provider is configured the challenge is still created but `delivery.status` is
  `provider_not_configured`; the response is `503` with that body so the client shows the honest
  state. (In `FS_DEV_MODE=1` the code is also written to the server console only, and
  `delivery.status = "dev_console"`.)

### POST /v1/auth/otp/verify
`{ "challengeId": "...", "code": "123456" }` → `200 { "token": "...", "user": User }`
- 5 attempts max per challenge, then `429`. Wrong code → `400 invalid_code`. Expired → `400 invalid_code`.

### POST /v1/auth/logout  → `204`

### GET /v1/me → `User`
```json
{ "id": "uuid", "phone": "+91...", "displayName": "Asha",
  "prefs": { "alertsFamily": true, "shareLocationOnEmergency": true, "nearbyHelperOptIn": false } }
```

### PATCH /v1/me
`{ "displayName"?: string(1..60), "prefs"?: { alertsFamily?: bool, shareLocationOnEmergency?: bool, nearbyHelperOptIn?: bool } }` → `User`

Consents are independent: turning on `alertsFamily` never enables location sharing or helper duty.

## 2. Family

Statuses: request `pending | accepted | rejected | cancelled`; connection `active | removed`.

### POST /v1/family/requests  `{ "phone": "+91..." }`
→ `200 { "request": Request }`
- Duplicate pending (either direction) → `409 already_requested`.
- Already active → `409 already_connected`. Self → `400 invalid_phone`.
- If the phone has no verified account: request is stored as an **invitation** (`to.userId: null`),
  `request.kind = "invitation"`, and it auto-links when that phone verifies at signup (still needs
  the invitee's explicit accept).
- Phone-number enumeration protection: the response never says whether the number is registered.
  `to` is always `{ "phoneMasked": "+91 ******3210" }`; `toName` only exists after acceptance.

### GET /v1/family
```json
{ "incoming": [Request], "outgoing": [Request],
  "connections": [{ "id": "...", "userId": "...", "name": "...", "phoneMasked": "...",
                    "since": "ISO", "alertsFamily": true }] }
```
`Request` = `{ "id", "direction": "incoming"|"outgoing", "kind": "request"|"invitation",
"status", "createdAt", "from": {"name","phoneMasked"}, "to": {"phoneMasked"} }`
Only `pending` requests are returned.

### POST /v1/family/requests/:id/accept | /reject  → `{ "request": Request }`
- Only the recipient may act (`404` otherwise). Accept creates one `active` connection
  (`409 already_connected` if it raced).

### DELETE /v1/family/connections/:id → `204`
Either side may revoke; both lose visibility.

## 3. Emergency

States, in order: `preparing → queued → sending → sent → notified → helper_accepted → resolved`,
plus terminal `cancelled`, `failed`, and `delivery_unknown`.
`notified` means "handed to the configured channel", **not** "delivered".

### POST /v1/emergency
Header `Idempotency-Key: <client uuid>` (same key within 24 h returns the same emergency).
```json
{ "location": { "lat": 17.38, "lng": 78.48, "accuracyM": 12, "ageSeconds": 0 } | null,
  "note": "optional 1..200 chars" }
```
→ `201`
```json
{ "emergency": { "id": "uuid", "state": "sent", "createdAt": "ISO", "expiresAt": "ISO",
                 "cancelledAt": null, "familyNotified": 2,
                 "nearby": { "state": "notified"|"no_helpers"|"no_location"|"not_configured"|"disabled",
                             "candidates": 3, "notified": 3 },
                 "family": [{ "name": "...", "status": "notified"|"no_channel" }] } }
```
- Requires `prefs.alertsFamily` OR an eligible helper audience; if location is absent,
  `nearby.state = "no_location"` and family delivery still proceeds.
- Rate limit: 3 / 30 min / user → `429`. A second request while one is active → `409 state_conflict`
  (client reuses the active one instead).

### GET /v1/emergency/:id → `{ "emergency": ... }`   (requester or assigned helper only)
### POST /v1/emergency/:id/cancel → `{ "emergency": ... }`
Cancels, stops further notifications, marks active assignments `cancelled`.

## 4. Nearby helpers

Matching: `FS_NEARBY_RADIUS_M` (default 2000), `FS_NEARBY_MAX_HELPERS` (default 5), Haversine on the
requester's snapshotted coordinates. Excluded: opted-out, requesters themselves, blocked pairs,
helpers already at their notification cap, expired/cancelled requests.

### GET /v1/helper/assignments → `{ "assignments": [Assignment] }`
```json
{ "id": "...", "emergencyId": "...", "status": "pending"|"accepted"|"declined"|"cancelled"|"expired",
  "createdAt": "...", "state": "notified",
  "request": { "displayName": "Asha", "distanceM": 850, "accuracyM": 12, "ageSeconds": 40,
               "note": null, "precise": false } }
```
`precise:false` → coordinates withheld until acceptance (`lat/lng` omitted).

### POST /v1/helper/assignments/:id/accept → `{ "assignment": Assignment, "requester": {...} }`
Atomic single-claim: `UPDATE ... WHERE status='pending'` in a transaction; losing racer gets
`409 already_claimed`. Only then are `lat`/`lng` returned.

### POST /v1/helper/assignments/:id/decline → `{ "assignment": {...} }`

### POST /v1/helper/location  `{ "location": { "lat": number, "lng": number, "accuracyM"?: number, "ageSeconds"?: number } }` → `204`
Publishes the caller's helper presence so `eligibleHelpers()` can match them. This is the **only**
writer of `helper_locations`; without a client call the distance matcher can never see an opted-in
volunteer. Requires `prefs.nearbyHelperOptIn === true` (otherwise `403 not_opted_in`) and a valid
coordinate pair (`400 invalid_body`). The row is UPSERTed per user and carries `updated_at`; matching
ignores it once older than `FS_HELPER_LOCATION_FRESH_MS`. Opting out does not delete the row — it flips
`users.helper_opt_in` to `0`, which `eligibleHelpers()` filters on, so a returning volunteer is matched
again immediately on the next publish. The client (`js/helper.js`) publishes on an interval only while
duty is on, the tab is visible, and the user is signed in.
### POST /v1/reports  `{ "assignmentId"?: string, "reason": "spam"|"abuse"|"other" }` → `202`
### POST /v1/devices  `{ "token": "...", "platform": "android" }` → `204`
### POST /v1/blocks  `{ "phone"?: string, "userId"?: string }` → `204`

## 5. Localisation

API payloads carry **no** user-facing prose except `message`, which the client logs — the UI renders
its own translated strings from `i18n.*.js`. Placeholder names come from user input.
