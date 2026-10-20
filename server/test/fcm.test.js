'use strict';
/*
 * FCM (HTTP v1) dispatch tests.
 *
 * These cover the half of push delivery that api.test.js cannot reach: the
 * service-account assertion, the messages:send payload the Android client
 * routes on, token pruning, and the honest "not configured" states.
 *
 * No network is used. `global.fetch` is replaced with a recorder that answers
 * the OAuth token exchange and messages:send from a queue, so the assertions
 * are about the bytes this server would put on the wire — not about Google.
 * config.js freezes its values at require time, so every FS_* variable is set
 * before the server modules are loaded.
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'familyshield-fcm-'));
const SECRET_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'familyshield-fcm-secret-'));

const PROJECT_ID = 'familyshield-fcm-test';
const CLIENT_EMAIL = 'pusher@' + PROJECT_ID + '.iam.gserviceaccount.com';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

// A throwaway RSA key so the JWT really is signed (and can be verified). It
// exists only in the temp dir for the lifetime of this process.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

const SERVICE_ACCOUNT_PATH = path.join(SECRET_DIR, 'service-account.json');
fs.writeFileSync(
  SERVICE_ACCOUNT_PATH,
  JSON.stringify({
    type: 'service_account',
    project_id: PROJECT_ID,
    client_email: CLIENT_EMAIL,
    private_key: PRIVATE_PEM,
    token_uri: TOKEN_URI
  })
);

// Same credentials, but without project_id: the "which project?" guard test.
const NO_PROJECT_PATH = path.join(SECRET_DIR, 'service-account-no-project.json');
fs.writeFileSync(
  NO_PROJECT_PATH,
  JSON.stringify({
    type: 'service_account',
    client_email: CLIENT_EMAIL,
    private_key: PRIVATE_PEM,
    token_uri: TOKEN_URI
  })
);

process.env.FS_DATA_DIR = DATA_DIR;
process.env.FS_DEV_MODE = '1';
// config.js validates these ranges at require time and refuses out-of-range values,
// so use the documented maxima: this file signs in one fresh phone per test.
process.env.FS_OTP_PHONE_LIMIT = '20';
process.env.FS_OTP_IP_LIMIT = '100';
process.env.FS_PUSH_PROVIDER = 'fcm';
process.env.FS_FCM_SERVICE_ACCOUNT = SERVICE_ACCOUNT_PATH;
delete process.env.FS_FCM_PROJECT_ID;

const index = require('../index.js');
const config = require('../config.js');
const { db } = require('../db.js');

/* ------------------------------------------------------------ fetch recorder */

const realFetch = global.fetch;
let fetchCalls = [];
let sendQueue = [];

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** Queues the next messages:send answer (default: accepted). */
function queueSend(status, body) {
  sendQueue.push({ status, body });
}

global.fetch = async (url, init) => {
  const href = String(url);
  const entry = { url: href, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body };
  fetchCalls.push(entry);
  if (href === TOKEN_URI) {
    return jsonResponse(200, { access_token: 'ya29.fake-access-token', expires_in: 3600 });
  }
  if (href.includes('/messages:send')) {
    const next = sendQueue.shift();
    if (!next) return jsonResponse(200, { name: 'projects/' + PROJECT_ID + '/messages/1' });
    if (next.body === undefined) return new Response('', { status: next.status });
    return jsonResponse(next.status, next.body);
  }
  throw new Error('unexpected fetch: ' + href);
};

/**
 * Fresh providers module => fresh OAuth credential cache. config is a plain
 * object, so tests can also point it at a different service-account file.
 */
function freshProviders() {
  delete require.cache[require.resolve('../providers.js')];
  return require('../providers.js');
}

function messagesSends() {
  return fetchCalls.filter((c) => c.url.includes('/messages:send'));
}

function tokenExchanges() {
  return fetchCalls.filter((c) => c.url === TOKEN_URI);
}

function resetRecorder() {
  fetchCalls = [];
  sendQueue = [];
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

/* ------------------------------------------------------------- HTTP + auth */

let server;
let port;
const ready = (async () => {
  server = index.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return port;
})();

async function call(method, routePath, options) {
  await ready;
  const { body, token } = options || {};
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers = { Connection: 'close' };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = payload.length;
  }
  if (token) headers.Authorization = 'Bearer ' + token;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: routePath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (err) {
          json = null;
        }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function signIn(phone) {
  const original = console.log;
  const codes = [];
  console.log = (...args) => {
    const match = /code (\d{6})/.exec(args.join(' '));
    if (match) codes.push(match[1]);
    original(...args);
  };
  let res;
  try {
    res = await call('POST', '/v1/auth/otp/request', { body: { phone } });
  } finally {
    console.log = original;
  }
  assert.strictEqual(res.status, 202, 'otp request: ' + res.text);
  assert.ok(codes[0], 'dev mode exposes the otp code');
  const verified = await call('POST', '/v1/auth/otp/verify', {
    body: { challengeId: res.json.challengeId, code: codes[0] }
  });
  assert.strictEqual(verified.status, 200, 'otp verify: ' + verified.text);
  assert.ok(verified.json.token);
  return verified.json;
}

async function registerDevice(session, token) {
  const res = await call('POST', '/v1/devices', { token: session.token, body: { token, platform: 'android' } });
  assert.strictEqual(res.status, 204, res.text);
}

after(async () => {
  global.fetch = realFetch;
  await ready.catch(() => {});
  if (server) {
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
  }
  try {
    db.close();
  } catch (err) {
    /* already closed */
  }
  for (const dir of [DATA_DIR, SECRET_DIR]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      /* a lingering WAL handle on Windows is not a test failure */
    }
  }
});

/* ------------------------------------------------------------------- tests */

test('service-account credentials are read from the configured file and cached', async () => {
  resetRecorder();
  const providers = freshProviders();
  const owner = await signIn('+919100000001');
  await registerDevice(owner, 'fcm-token-cache');

  const first = await providers.pushToUser(owner.user.id, { type: 'family_emergency', emergencyId: 'emg-cache' }, 'emg-cache');
  assert.strictEqual(first.status, 'sent', JSON.stringify(first));
  assert.strictEqual(first.dispatched, 1);
  assert.strictEqual(first.delivered, 1);
  assert.strictEqual(tokenExchanges().length, 1, 'one OAuth exchange');

  const exchange = tokenExchanges()[0];
  assert.strictEqual(exchange.method, 'POST');
  const params = new URLSearchParams(exchange.body);
  assert.strictEqual(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const assertion = params.get('assertion');
  assert.ok(assertion && assertion.split('.').length === 3, 'a three-part JWT assertion');

  const [header, claim, signature] = assertion.split('.');
  assert.deepStrictEqual(decodeSegment(header), { alg: 'RS256', typ: 'JWT' });
  const claims = decodeSegment(claim);
  assert.strictEqual(claims.iss, CLIENT_EMAIL, 'iss is the service-account client_email');
  assert.strictEqual(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.strictEqual(claims.aud, TOKEN_URI);
  assert.ok(claims.exp - claims.iat === 3600, 'one hour lifetime');

  // The signature is a real RS256 signature over header.claim.
  const verified = crypto
    .createVerify('RSA-SHA256')
    .update(header + '.' + claim)
    .verify(publicKey, Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  assert.strictEqual(verified, true, 'JWT signed with the service-account private key');

  // Second dispatch must reuse the cached token: no second exchange.
  const second = await providers.pushToUser(owner.user.id, { type: 'family_request', requestId: 'req-1' });
  assert.strictEqual(second.status, 'sent');
  assert.strictEqual(tokenExchanges().length, 1, 'access token is cached between sends');
});

test('messages:send targets the project from the service-account file', async () => {
  resetRecorder();
  const providers = freshProviders();
  const owner = await signIn('+919100000002');
  await registerDevice(owner, 'fcm-token-project');

  await providers.pushToUser(owner.user.id, { type: 'family_emergency', emergencyId: 'emg-project' }, 'emg-project');
  const [send] = messagesSends();
  assert.ok(send, 'a messages:send call happened');
  assert.strictEqual(
    send.url,
    'https://fcm.googleapis.com/v1/projects/' + PROJECT_ID + '/messages:send',
    'project id comes from project_id in the service-account JSON'
  );
  assert.strictEqual(send.method, 'POST');
  assert.strictEqual(send.headers.Authorization, 'Bearer ya29.fake-access-token');
  assert.strictEqual(send.headers['Content-Type'], 'application/json');
});

test('the payload carries the data keys FsPush.targetFor() routes on', async () => {
  resetRecorder();
  const providers = freshProviders();
  const owner = await signIn('+919100000003');
  await registerDevice(owner, 'fcm-token-payload');

  await providers.pushToUser(owner.user.id, { type: 'family_emergency', emergencyId: 'emg-42', note: 7 }, 'emg-42');
  await providers.pushToUser(owner.user.id, { type: 'helper_request', assignmentId: 'asg-9', emergencyId: 'emg-42', distanceM: 120 });
  await providers.pushToUser(owner.user.id, { type: 'family_request', requestId: 'fr-3' });

  const sends = messagesSends();
  assert.strictEqual(sends.length, 3);

  const [emergencyMsg, helperMsg, familyMsg] = sends.map((s) => JSON.parse(s.body));

  // family_emergency -> data type + emergencyId
  assert.strictEqual(emergencyMsg.message.token, 'fcm-token-payload');
  assert.strictEqual(emergencyMsg.message.data.type, 'family_emergency');
  assert.strictEqual(emergencyMsg.message.data.emergencyId, 'emg-42');
  assert.strictEqual(emergencyMsg.message.notification.title, 'FamilyShield');
  assert.strictEqual(emergencyMsg.message.notification.body, 'A family member has requested emergency assistance.');
  // Android delivery requirements.
  assert.strictEqual(emergencyMsg.message.android.priority, 'high');
  assert.strictEqual(emergencyMsg.message.android.notification.channel_id, 'familyshield_alerts');

  // helper_request -> data type + assignmentId
  assert.strictEqual(helperMsg.message.data.type, 'helper_request');
  assert.strictEqual(helperMsg.message.data.assignmentId, 'asg-9');
  assert.strictEqual(helperMsg.message.data.emergencyId, 'emg-42');
  assert.strictEqual(helperMsg.message.notification.body, 'Someone nearby needs emergency assistance.');

  // family_request -> data type + requestId, generic lock-screen text
  assert.strictEqual(familyMsg.message.data.type, 'family_request');
  assert.strictEqual(familyMsg.message.data.requestId, 'fr-3');
  assert.strictEqual(familyMsg.message.notification.body, 'Open FamilyShield to view the update.');

  // FCM rejects non-string data values, so every data value must be a string.
  for (const msg of [emergencyMsg, helperMsg, familyMsg]) {
    for (const [key, value] of Object.entries(msg.message.data)) {
      assert.strictEqual(typeof value, 'string', key + ' must be stringified');
    }
  }
  assert.strictEqual(emergencyMsg.message.data.note, '7', 'numbers are coerced');

  // Lock-screen text must never carry identity, phone or coordinates.
  for (const msg of [emergencyMsg, helperMsg, familyMsg]) {
    const text = msg.message.notification.title + ' ' + msg.message.notification.body;
    assert.ok(!/\+?\d{7,}/.test(text), 'no phone-number-like text on the lock screen');
    assert.ok(!/emg-|asg-|fr-/.test(text), 'no internal ids on the lock screen');
  }
});

test('pushes fan out only to the target user’s own devices', async () => {
  resetRecorder();
  const providers = freshProviders();
  const alice = await signIn('+919100000004');
  const bob = await signIn('+919100000005');
  await registerDevice(alice, 'fcm-token-alice');

  // Bob has no device: nothing is sent, and the state says so.
  const none = await providers.pushToUser(bob.user.id, { type: 'family_request', requestId: 'fr-x' });
  assert.deepStrictEqual(
    { status: none.status, delivered: none.delivered, dispatched: none.dispatched },
    { status: 'no_device', delivered: 0, dispatched: 0 }
  );
  assert.strictEqual(messagesSends().length, 0, 'no push for a user without devices');

  // Alice's token is never addressed on Bob's behalf.
  const toAlice = await providers.pushToUser(alice.user.id, { type: 'family_request', requestId: 'fr-y' });
  assert.strictEqual(toAlice.status, 'sent');
  assert.strictEqual(toAlice.dispatched, 1);
  const [send] = messagesSends();
  assert.strictEqual(JSON.parse(send.body).message.token, 'fcm-token-alice');

  // A handed-over phone: re-registering the same token moves ownership and the
  // previous owner stops being a push target for it.
  await registerDevice(bob, 'fcm-token-alice');
  const stillAlice = await providers.pushToUser(alice.user.id, { type: 'family_request', requestId: 'fr-z' });
  assert.strictEqual(stillAlice.status, 'no_device', 'the old owner no longer owns the token');
  const nowBob = await providers.pushToUser(bob.user.id, { type: 'family_request', requestId: 'fr-w' });
  assert.strictEqual(nowBob.status, 'sent', 'the token delivers to its latest owner');
});

test('UNREGISTERED / INVALID_ARGUMENT tokens are pruned, other failures keep the row', async () => {
  resetRecorder();
  const providers = freshProviders();
  const owner = await signIn('+919100000006');
  await registerDevice(owner, 'fcm-token-dead');

  queueSend(404, { error: { status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } });
  const pruned = await providers.pushToUser(owner.user.id, { type: 'family_emergency', emergencyId: 'emg-dead' }, 'emg-dead');
  assert.strictEqual(pruned.status, 'failed');
  assert.strictEqual(pruned.delivered, 0);
  assert.strictEqual(pruned.pruned, 1, 'a permanently invalid token is dropped');
  assert.strictEqual(db.prepare('SELECT 1 FROM devices WHERE token = ?').get('fcm-token-dead'), undefined);

  // A 400 INVALID_ARGUMENT is also permanent.
  await registerDevice(owner, 'fcm-token-bad-arg');
  queueSend(400, { error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'INVALID_ARGUMENT' }] } });
  const invalid = await providers.pushToUser(owner.user.id, { type: 'family_emergency', emergencyId: 'emg-bad' }, 'emg-bad');
  assert.strictEqual(invalid.pruned, 1);
  assert.strictEqual(db.prepare('SELECT 1 FROM devices WHERE token = ?').get('fcm-token-bad-arg'), undefined);

  // A 500/403 that is not token-related must NOT delete a valid registration.
  await registerDevice(owner, 'fcm-token-temporary');
  queueSend(403, { error: { status: 'PERMISSION_DENIED', details: [{ errorCode: 'THIRD_PARTY_AUTH_ERROR' }] } });
  const kept = await providers.pushToUser(owner.user.id, { type: 'family_emergency', emergencyId: 'emg-keep' }, 'emg-keep');
  assert.strictEqual(kept.status, 'failed');
  assert.strictEqual(kept.pruned, 0, 'only token-fatal errors prune');
  assert.ok(db.prepare('SELECT 1 FROM devices WHERE token = ?').get('fcm-token-temporary'), 'row survives');

  // Delivery outcomes are recorded honestly (sent vs failed), never as "read".
  // Scope to this test's own emergencies: the ledger is shared with earlier tests.
  const logged = db
    .prepare(
      "SELECT emergency_id, status, detail FROM notifications WHERE channel = 'push' AND provider = 'fcm' AND emergency_id IN ('emg-dead','emg-bad','emg-keep') ORDER BY rowid"
    )
    .all();
  assert.strictEqual(logged.length, 3);
  const byEmergency = new Map(logged.map((row) => [row.emergency_id, row]));
  assert.strictEqual(byEmergency.get('emg-dead').status, 'failed');
  assert.match(String(byEmergency.get('emg-dead').detail), /UNREGISTERED/);
  assert.strictEqual(byEmergency.get('emg-keep').status, 'failed');
  assert.match(String(byEmergency.get('emg-keep').detail), /PERMISSION_DENIED|HTTP 403/);
  for (const row of logged) assert.notStrictEqual(row.status, 'read', 'push never claims read');
});

test('transient provider failures are retried once and never prune', async () => {
  resetRecorder();
  const providers = freshProviders();
  const owner = await signIn('+919100000007');
  await registerDevice(owner, 'fcm-token-flaky');

  queueSend(503, { error: { status: 'UNAVAILABLE' } });
  queueSend(503, { error: { status: 'UNAVAILABLE' } });
  const result = await providers.pushToUser(owner.user.id, { type: 'family_emergency', emergencyId: 'emg-flaky' }, 'emg-flaky');
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.pruned, 0, 'a 503 says nothing about the token');
  assert.strictEqual(messagesSends().length, 2, 'exactly one retry');
  assert.ok(db.prepare('SELECT 1 FROM devices WHERE token = ?').get('fcm-token-flaky'));
});

test('an unconfigured push provider reports provider_not_configured and sends nothing', async () => {
  resetRecorder();
  const providers = freshProviders();
  const owner = await signIn('+919100000008');
  await registerDevice(owner, 'fcm-token-unconfigured');

  const originalPath = config.fcm.serviceAccountPath;
  config.fcm.serviceAccountPath = '';
  try {
    assert.strictEqual(providers.pushConfigured(), false);
    const result = await providers.pushToUser(owner.user.id, { type: 'family_emergency', emergencyId: 'emg-none' }, 'emg-none');
    assert.deepStrictEqual(
      { status: result.status, delivered: result.delivered, dispatched: result.dispatched, pruned: result.pruned },
      { status: 'provider_not_configured', delivered: 0, dispatched: 0, pruned: 0 }
    );
    assert.strictEqual(fetchCalls.length, 0, 'no HTTP at all without credentials');
  } finally {
    config.fcm.serviceAccountPath = originalPath;
  }

  // A configured path that does not exist is also "not configured", not a crash.
  config.fcm.serviceAccountPath = path.join(SECRET_DIR, 'missing-service-account.json');
  try {
    assert.strictEqual(providers.pushConfigured(), false);
  } finally {
    config.fcm.serviceAccountPath = originalPath;
  }
});

test('a service account without a project id is refused before any messages:send', async () => {
  resetRecorder();
  const originalPath = config.fcm.serviceAccountPath;
  const originalProject = config.fcm.projectId;
  config.fcm.serviceAccountPath = NO_PROJECT_PATH;
  config.fcm.projectId = '';
  let providers;
  try {
    providers = freshProviders(); // fresh credential cache, or the guard is skipped
    const owner = await signIn('+919100000009');
    await registerDevice(owner, 'fcm-token-no-project');

    const result = await providers.pushToUser(owner.user.id, { type: 'family_emergency', emergencyId: 'emg-noproject' }, 'emg-noproject');
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.delivered, 0);
    assert.strictEqual(messagesSends().length, 0, 'no /projects//messages:send request');
    const logged = db
      .prepare("SELECT status, detail FROM notifications WHERE channel = 'push' ORDER BY rowid DESC LIMIT 1")
      .get();
    assert.strictEqual(logged.status, 'failed');
    assert.match(String(logged.detail), /no FCM project id/);
  } finally {
    config.fcm.serviceAccountPath = originalPath;
    config.fcm.projectId = originalProject;
    freshProviders();
  }
});

test('a caller can only unregister devices it owns', async () => {
  resetRecorder();
  const providers = freshProviders();
  const alice = await signIn('+919100000011');
  const bob = await signIn('+919100000012');
  await registerDevice(alice, 'fcm-token-alice-owned');
  await registerDevice(bob, 'fcm-token-bob-owned');

  // Bob names Alice's token: the DELETE is owner-scoped, so nothing is removed.
  const stolen = await call('DELETE', '/v1/devices', { token: bob.token, body: { token: 'fcm-token-alice-owned' } });
  assert.strictEqual(stolen.status, 204);
  assert.ok(db.prepare('SELECT 1 FROM devices WHERE token = ?').get('fcm-token-alice-owned'), 'row survives');
  assert.strictEqual((await providers.pushToUser(alice.user.id, { type: 'family_request', requestId: 'fr-a' })).delivered, 1);

  // Without a token body only the caller's own registrations go away.
  const purge = await call('DELETE', '/v1/devices', { token: bob.token, body: {} });
  assert.strictEqual(purge.status, 204);
  assert.strictEqual(db.prepare('SELECT 1 FROM devices WHERE token = ?').get('fcm-token-bob-owned'), undefined);
  assert.ok(db.prepare('SELECT 1 FROM devices WHERE token = ?').get('fcm-token-alice-owned'), 'other users untouched');
});

test('device registration validates the token and platform before storing it', async () => {
  const owner = await signIn('+919100000010');

  const anonymous = await call('POST', '/v1/devices', { body: { token: 'fcm-token-anon' } });
  assert.strictEqual(anonymous.status, 401);
  assert.strictEqual(anonymous.json.error, 'unauthorized');

  const empty = await call('POST', '/v1/devices', { token: owner.token, body: { token: '   ' } });
  assert.strictEqual(empty.status, 400);
  assert.strictEqual(empty.json.error, 'invalid_body');

  const tooLong = await call('POST', '/v1/devices', { token: owner.token, body: { token: 'x'.repeat(4097) } });
  assert.strictEqual(tooLong.status, 400);
  assert.strictEqual(tooLong.json.error, 'invalid_body');

  const badPlatform = await call('POST', '/v1/devices', {
    token: owner.token,
    body: { token: 'fcm-token-platform', platform: 'ANDROID' }
  });
  assert.strictEqual(badPlatform.status, 400);
  assert.strictEqual(badPlatform.json.error, 'invalid_body');

  // Ownership always comes from the session, never from a body field.
  const spoofed = await call('POST', '/v1/devices', {
    token: owner.token,
    body: { token: 'fcm-token-owned', platform: 'android', userId: 'somebody-else' }
  });
  assert.strictEqual(spoofed.status, 204);
  const row = db.prepare('SELECT user_id FROM devices WHERE token = ?').get('fcm-token-owned');
  assert.strictEqual(row.user_id, owner.user.id);
});
