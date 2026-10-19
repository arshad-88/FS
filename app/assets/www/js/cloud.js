/* FamilyShield cloud panel: real OTP auth, family consent, screenshot OCR.
 * Classic script; all network calls are real fetches to FS_BASE. There is no
 * offline fallback that pretends an action succeeded — every state rendered
 * here came from the server or from native bridge output. */
(function () {
  'use strict';

  var FS = window.FS || (window.FS = {});
  var Cloud = FS.cloud || (FS.cloud = {});
  var doc = document;

  var SESSION_KEY = 'fs.session.v1';
  var FALLBACK_BASE = 'http://10.0.2.2:8787';

  var STATE = {
    user: null,
    token: null,
    challengeId: null,
    connections: [],
    incoming: [],
    outgoing: [],
    busy: false,
    message: null,
    ocrAvailable: false,
    ocrPath: ''
  };

  function t(key, fallback, params) {
    var value = FS.app && typeof FS.app.t === 'function' ? FS.app.t(key) : key;
    if (value === key) value = fallback;
    if (params) {
      Object.keys(params).forEach(function (name) {
        value = value.split('{' + name + '}').join(String(params[name]));
      });
    }
    return value;
  }

  function store() {
    return FS.store || {
      get: function (k, f) { try { var v = localStorage.getItem(k); return v == null ? f : v; } catch (e) { return f; } },
      set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
    };
  }

  function el(tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function bridge() {
    var b = FS.android || window.FSAndroid || window.AndroidBridge || null;
    if (!b) return null;
    return typeof b.isFamilyShieldBridge === 'function' && !b.isFamilyShieldBridge() ? null : b;
  }

  function callNative(name, args) {
    var b = bridge();
    if (!b || typeof b[name] !== 'function') return null;
    try { return b[name].apply(b, args || []); } catch (err) { return null; }
  }

  function baseUrl() {
    if (typeof window.FS_BASE === 'string' && /^https?:\/\//i.test(window.FS_BASE)) {
      if (window.FS_BASE.charAt(window.FS_BASE.length - 1) === '/') {
        return window.FS_BASE.slice(0, -1);
      }
      return window.FS_BASE;
    }
    // The bridge names this getBackendOrigin(); apiBaseUrl is kept as a fallback for older
    // shells. Reading the wrong name silently pinned every device to the emulator origin.
    var native = callNative('getBackendOrigin');
    if (typeof native !== 'string' || !native) native = callNative('apiBaseUrl');
    if (typeof native === 'string' && /^https?:\/\//i.test(native)) {
      return native.replace(/\/+$/, '');
    }
    return FALLBACK_BASE;
  }

  /* ---------- session ---------- */

  function persistSession() {
    store().set(SESSION_KEY, JSON.stringify({ token: STATE.token, user: STATE.user }));
  }

  function restoreSession() {
    try {
      var raw = store().get(SESSION_KEY, '');
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && parsed.token && parsed.user) {
        STATE.token = parsed.token;
        STATE.user = parsed.user;
      }
    } catch (err) { /* corrupt session is discarded on next verify */ }
  }

  function clearSession() {
    STATE.token = null;
    STATE.user = null;
    store().set(SESSION_KEY, '');
  }

  // Push registration follows the authenticated session, never the device:
  // the FCM token is bound to whoever is signed in. Kept optional so the app
  // still works if push.js is unavailable (web preview, old APK).
  function pushHook(action) {
    var mod = typeof window !== 'undefined' && window.FS ? window.FS.push : null;
    if (mod && typeof mod[action] === 'function') {
      try { mod[action](); } catch (err) { /* best effort: never block auth */ }
    }
  }
  function syncPush() { pushHook('sync'); }

  function api(path, options) {
    options = options || {};
    var headers = { 'Content-Type': 'application/json' };
    if (options.headers) {
      for (var key in options.headers) {
        if (Object.prototype.hasOwnProperty.call(options.headers, key)) headers[key] = options.headers[key];
      }
    }
    if (STATE.token) headers.Authorization = 'Bearer ' + STATE.token;
    var url = /^https?:/i.test(path) ? path : baseUrl() + path;
    return fetch(url, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store'
    }).then(function (res) {
      // 204 responses (logout, connection delete) carry no body at all, so the
      // body is read as text and only parsed when it is non-empty.
      return res.text().then(function (text) {
        var data = {};
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (err) {
            data = { message: text.slice(0, 200) };
          }
        }
        if (res.status === 401 && STATE.token) {
          clearSession();
          render();
        }
        if (!res.ok) {
          var error = new Error(data.message || data.error || ('HTTP ' + res.status));
          error.code = data.error || 'http_error';
          error.status = res.status;
          error.data = data;
          throw error;
        }
        return data && typeof data === 'object' ? data : {};
      });
    }, function () {
      var netError = new Error('network_unreachable');
      netError.code = 'network';
      throw netError;
    });
  }

  function setMessage(kind, text) {
    STATE.message = text ? { kind: kind, text: text } : null;
  }

  // Server error codes documented in docs/API.md, mapped to honest UI copy.
  var ERROR_TEXT = {
    rate_limited: ['cloud.rateLimited', 'Too many attempts. Please wait and retry.'],
    invalid_phone: ['cloud.invalidPhone', 'Enter the number with country code, e.g. +919876543210.'],
    invalid_code: ['cloud.invalidCode', 'That code is wrong or expired. Request a new one.'],
    unauthorized: ['cloud.sessionExpired', 'Your session expired. Sign in again.'],
    forbidden: ['cloud.forbidden', 'You are not allowed to do that.'],
    not_found: ['cloud.notFound', 'That item no longer exists.'],
    already_requested: ['cloud.alreadyRequested', 'There is already a pending request with this number.'],
    already_connected: ['cloud.alreadyConnected', 'You are already connected with this person.'],
    not_opted_in: ['cloud.notOptedIn', 'Enable nearby-helper duty in your alerts first.'],
    state_conflict: ['cloud.stateConflict', 'The emergency changed state. Refresh and try again.'],
    provider_not_configured: ['cloud.noSmsProvider', 'SMS delivery is not configured on the server yet.'],
    delivery_failed: ['cloud.deliveryFailed', 'The code could not be delivered. Try again in a moment.']
  };

  function describeError(err) {
    if (!err) return '';
    if (err.code === 'network' || err.message === 'Failed to fetch') {
      return t('cloud.unreachable', 'Server unreachable. Check the API address and your connection.');
    }
    var mapped = err.code && ERROR_TEXT[err.code];
    if (mapped) {
      var base = t(mapped[0], mapped[1]);
      if (err.data && err.data.retryAfterSeconds) base += ' (' + err.data.retryAfterSeconds + 's)';
      return base;
    }
    return err.message || t('err.generic', 'Something went wrong. Please try again.');
  }

  /* ---------- auth UI ---------- */

  function authCard() {
    var phone = el('input', 'field');
    phone.type = 'tel';
    phone.inputMode = 'tel';
    phone.autocomplete = 'tel';
    phone.placeholder = '+91 98765 43210';
    phone.setAttribute('aria-label', t('cloud.phone', 'Phone number'));

    var code = el('input', 'field');
    code.type = 'text';
    code.inputMode = 'numeric';
    code.autocomplete = 'one-time-code';
    code.maxLength = 6;
    code.placeholder = t('cloud.code', '6-digit code');
    code.setAttribute('aria-label', t('cloud.code', '6-digit code'));

    var devHint = el('p', 'cloud-hint');
    var sendBtn = el('button', 'btn btn-primary', t('cloud.sendCode', 'Send code'));
    sendBtn.type = 'button';
    var verifyBtn = el('button', 'btn', t('cloud.verify', 'Verify'));
    verifyBtn.type = 'button';
    // A code was already requested and the card was re-rendered: keep Verify usable
    // and restore what the user had typed instead of wiping the form.
    verifyBtn.disabled = !STATE.challengeId;
    if (STATE.phoneDraft) phone.value = STATE.phoneDraft;
    if (STATE.codeDraft) code.value = STATE.codeDraft;
    if (STATE.authHint) devHint.textContent = STATE.authHint;
    phone.addEventListener('input', function () { STATE.phoneDraft = phone.value; });
    code.addEventListener('input', function () { STATE.codeDraft = code.value; });

    sendBtn.addEventListener('click', function () {
      var value = phone.value.trim();
      STATE.phoneDraft = value;
      if (!/^\+[1-9]\d{7,14}$/.test(value)) {
        setMessage('error', t('cloud.invalidPhone', 'Enter the number with country code, e.g. +919876543210.'));
        render();
        return;
      }
      sendBtn.disabled = true;
      // POST /v1/auth/otp/request { phone } -> 202 { challengeId, expiresInSeconds, delivery }
      // The code itself is never returned; only a dev-mode server logs it.
      api('/v1/auth/otp/request', { method: 'POST', body: { phone: value } })
        .then(function (data) {
          if (!data.challengeId) throw new Error(t('err.generic', 'Something went wrong. Please try again.'));
          STATE.challengeId = data.challengeId;
          verifyBtn.disabled = false;
          code.value = '';
          code.focus();
          var channel = data.delivery && data.delivery.status;
          if (channel === 'provider_not_configured') {
            // Server answered 503 for this case, so it normally lands in catch below.
            STATE.authHint = t('cloud.noSmsProvider', 'SMS delivery is not configured on the server yet.');
          } else if (channel === 'dev_console') {
            STATE.authHint = t('cloud.devCode', 'Development mode: the code is printed in the server console.');
          } else if (data.expiresInSeconds) {
            STATE.authHint = t('cloud.codeSent', 'Code sent. It expires in a few minutes.')
              + ' (' + Math.round(data.expiresInSeconds / 60) + ' min)';
          } else {
            STATE.authHint = t('cloud.codeSent', 'Code sent. It expires in a few minutes.');
          }
          devHint.textContent = STATE.authHint;
          setMessage('ok', t('cloud.codeSent', 'Code sent. It expires in a few minutes.'));
        })
        .catch(function (err) {
          // 503 provider_not_configured / 429 rate_limited land here; describeError
          // turns the server error code into the honest message.
          STATE.authHint = '';
          devHint.textContent = '';
          setMessage('error', describeError(err));
        })
        .then(function () { sendBtn.disabled = false; render(); });
    });

    verifyBtn.addEventListener('click', function () {
      var digits = code.value.replace(/\D+/g, '');
      if (!STATE.challengeId) {
        setMessage('error', t('cloud.requestFirst', 'Request a code first.'));
        render();
        return;
      }
      if (!/^\d{6}$/.test(digits)) {
        setMessage('error', t('cloud.invalidCode', 'Enter the 6-digit code from the SMS.'));
        render();
        return;
      }
      verifyBtn.disabled = true;
      // POST /v1/auth/otp/verify { challengeId, code } -> 200 { token, user }
      api('/v1/auth/otp/verify', { method: 'POST', body: { challengeId: STATE.challengeId, code: digits } })
        .then(function (data) {
          if (!data.token) throw new Error(t('err.generic', 'Something went wrong. Please try again.'));
          STATE.challengeId = null;
          STATE.phoneDraft = '';
          STATE.codeDraft = '';
          STATE.authHint = '';
          STATE.token = data.token;
          STATE.user = data.user || null;
          persistSession();
          syncPush();
          setMessage('ok', t('cloud.signedIn', 'Signed in.'));
          return refresh();
        })
        .catch(function (err) {
          setMessage('error', describeError(err));
        })
        .then(function () { verifyBtn.disabled = false; render(); });
    });

    var card = el('div', 'cloud-card');
    card.appendChild(el('h3', 'cloud-title', t('cloud.signInTitle', 'Sign in with your phone')));
    card.appendChild(el('p', 'cloud-hint', t('cloud.signInHint', 'We text a one-time code to verify this number. Family links require the other person to approve.')));
    card.appendChild(phone);
    card.appendChild(sendBtn);
    card.appendChild(devHint);
    card.appendChild(code);
    card.appendChild(verifyBtn);
    return card;
  }

  /* ---------- account + family UI ---------- */

  function accountCard() {
    var card = el('div', 'cloud-card');
    var head = el('div', 'cloud-row');
    head.appendChild(el('span', 'cloud-avatar', (STATE.user.displayName || STATE.user.phone || '?').slice(0, 1).toUpperCase()));
    var names = el('div', 'cloud-grow');
    names.appendChild(el('strong', null, STATE.user.displayName || t('cloud.noName', 'No display name yet')));
    names.appendChild(el('span', 'cloud-hint', STATE.user.phone));
    head.appendChild(names);
    card.appendChild(head);

    nameEditor(card);

    var logout = el('button', 'btn', t('cloud.signOut', 'Sign out'));
    logout.type = 'button';
    logout.addEventListener('click', function () {
      // POST /v1/auth/logout -> 204 (no body)
      // Unregister this device before the session dies so it stops receiving
      // alerts for the account that is signing out.
      pushHook('signOut');
      api('/v1/auth/logout', { method: 'POST' }).catch(function () { /* token is cleared locally either way */ });
      clearSession();
      STATE.connections = [];
      STATE.incoming = [];
      STATE.outgoing = [];
      STATE.challengeId = null;
      setMessage('ok', t('cloud.signedOut', 'Signed out.'));
      render();
    });
    card.appendChild(logout);
    return card;
  }

  function nameEditor(card) {
    var input = el('input', 'field');
    input.type = 'text';
    input.maxLength = 48;
    input.value = STATE.user.displayName || '';
    input.placeholder = t('cloud.displayName', 'Your name (shown to your family)');
    input.setAttribute('aria-label', t('cloud.displayName', 'Your name'));
    var save = el('button', 'btn', t('cloud.saveName', 'Save name'));
    save.type = 'button';
    save.addEventListener('click', function () {
      var name = input.value.trim();
      if (!name || name.length > 60) {
        setMessage('error', t('cloud.nameInvalid', 'Enter a name of 1 to 60 characters.'));
        render();
        return;
      }
      save.disabled = true;
      // PATCH /v1/me { displayName } -> the bare User object (not wrapped)
      api('/v1/me', { method: 'PATCH', body: { displayName: name } })
        .then(function (data) {
          STATE.user = data && data.id ? data : STATE.user;
          STATE.user.displayName = name;
          persistSession();
          setMessage('ok', t('cloud.nameSaved', 'Name saved.'));
        })
        .catch(function (err) { setMessage('error', describeError(err)); })
        .then(function () { save.disabled = false; render(); });
    });
    card.appendChild(input);
    card.appendChild(save);
  }

  function inviteCard() {
    var card = el('div', 'cloud-card');
    card.appendChild(el('h3', 'cloud-title', t('cloud.familyTitle', 'Family circle')));
    card.appendChild(el('p', 'cloud-hint', t('cloud.familyHint', 'Adding a number sends an invitation. They must sign in and approve before any location or alert can reach them.')));

    var phone = el('input', 'field');
    phone.type = 'tel';
    phone.inputMode = 'tel';
    phone.placeholder = '+91 98765 43210';
    phone.setAttribute('aria-label', t('cloud.invitePhone', 'Family member phone number'));
    var add = el('button', 'btn btn-primary', t('cloud.invite', 'Send invitation'));
    add.type = 'button';
    add.addEventListener('click', function () {
      var value = phone.value.trim();
      if (!/^\+[1-9]\d{7,14}$/.test(value)) {
        setMessage('error', t('cloud.invalidPhone', 'Enter the number with country code, e.g. +919876543210.'));
        render();
        return;
      }
      add.disabled = true;
      // POST /v1/family/requests { phone } -> { request: Request }
      // The server is the source of truth on duplicates (409 already_requested /
      // already_connected) and never says whether the number is registered; the
      // only hint is request.kind === 'invitation'.
      api('/v1/family/requests', { method: 'POST', body: { phone: value } })
        .then(function (data) {
          var request = data && data.request;
          if (request && request.kind === 'invitation') {
            setMessage('ok', t('cloud.inviteSent', 'Invitation sent. It stays pending until they approve.'));
          } else {
            setMessage('ok', t('cloud.requestSent', 'Request sent. It stays pending until they approve.'));
          }
          phone.value = '';
          return refresh();
        })
        .catch(function (err) { setMessage('error', describeError(err)); })
        .then(function () { add.disabled = false; render(); });
    });
    card.appendChild(phone);
    card.appendChild(add);
    return card;
  }

  // Request statuses (pending | accepted | rejected | cancelled) and connection
  // statuses (active | removed) per docs/API.md.
  function statusLabel(status) {
    var map = {
      pending: t('cloud.pending', 'Pending approval'),
      accepted: t('cloud.accepted', 'Accepted'),
      rejected: t('cloud.declined', 'Declined'),
      cancelled: t('cloud.cancelled', 'Cancelled'),
      active: t('cloud.connected', 'Connected'),
      removed: t('cloud.removedState', 'Removed')
    };
    return map[status] || status;
  }

  function formatSince(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return t('cloud.since', 'Connected since') + ' ' + d.toLocaleDateString();
    } catch (err) {
      return '';
    }
  }

  function consentList() {
    var card = el('div', 'cloud-card');
    card.appendChild(el('h3', 'cloud-title', t('cloud.consentTitle', 'Connected family')));
    if (!STATE.connections.length) {
      card.appendChild(el('p', 'cloud-hint', t('cloud.noFamily', 'No family members yet. Invite someone above.')));
      return card;
    }
    // GET /v1/family -> connections: [{ id, userId, name, phoneMasked, since, alertsFamily }]
    STATE.connections.forEach(function (row) {
      var item = el('div', 'cloud-person');
      var info = el('div', 'cloud-grow');
      info.appendChild(el('strong', null, row.name || t('cloud.unnamed', 'Unnamed contact')));
      var since = formatSince(row.since);
      info.appendChild(el('span', 'cloud-hint', row.phoneMasked + (since ? ' · ' + since : '')));
      if (row.alertsFamily) info.appendChild(el('span', 'cloud-badge', t('cloud.alertsOn', 'Gets your emergency alerts')));
      item.appendChild(info);

      var remove = el('button', 'btn btn-small', t('cloud.remove', 'Remove'));
      remove.type = 'button';
      remove.addEventListener('click', function () {
        remove.disabled = true;
        // DELETE /v1/family/connections/:id -> 204 (either side may revoke)
        api('/v1/family/connections/' + encodeURIComponent(row.id), { method: 'DELETE' })
          .then(function () { setMessage('ok', t('cloud.removed', 'Removed.')); return refresh(); })
          .catch(function (err) { setMessage('error', describeError(err)); })
          .then(function () { remove.disabled = false; render(); });
      });
      item.appendChild(remove);
      card.appendChild(item);
    });
    return card;
  }

  // Request = { id, direction, kind, status, createdAt, from:{name,phoneMasked}, to:{phoneMasked} }
  function inboxCard() {
    if (!STATE.incoming.length) return null;
    var card = el('div', 'cloud-card');
    card.appendChild(el('h3', 'cloud-title', t('cloud.incomingTitle', 'Waiting for your approval')));
    STATE.incoming.forEach(function (row) {
      var item = el('div', 'cloud-person');
      var info = el('div', 'cloud-grow');
      var who = (row.from && (row.from.name || row.from.phoneMasked)) || t('cloud.unnamed', 'Unnamed contact');
      info.appendChild(el('strong', null, who));
      info.appendChild(el('span', 'cloud-hint', row.kind === 'invitation'
        ? t('cloud.invitedYou', 'invited you to their family circle')
        : t('cloud.wantsToConnect', 'wants to connect as family')));
      item.appendChild(info);

      function respond(action, okText) {
        return function () {
          // POST /v1/family/requests/:id/accept | /reject -> { request: Request }
          api('/v1/family/requests/' + encodeURIComponent(row.id) + '/' + action, { method: 'POST' })
            .then(function () { setMessage('ok', okText); return refresh(); })
            .catch(function (err) { setMessage('error', describeError(err)); })
            .then(function () { render(); });
        };
      }

      var yes = el('button', 'btn btn-small btn-primary', t('cloud.approve', 'Approve'));
      yes.type = 'button';
      yes.addEventListener('click', function () {
        yes.disabled = true;
        respond('accept', t('cloud.approved', 'Connection approved.'))();
      });
      var no = el('button', 'btn btn-small', t('cloud.decline', 'Decline'));
      no.type = 'button';
      no.addEventListener('click', function () {
        no.disabled = true;
        respond('reject', t('cloud.declinedNote', 'Declined.'))();
      });
      item.appendChild(yes);
      item.appendChild(no);
      card.appendChild(item);
    });
    return card;
  }

  function outgoingCard() {
    if (!STATE.outgoing.length) return null;
    var card = el('div', 'cloud-card');
    card.appendChild(el('h3', 'cloud-title', t('cloud.outgoingTitle', 'Sent by you')));
    STATE.outgoing.forEach(function (row) {
      var item = el('div', 'cloud-person');
      var info = el('div', 'cloud-grow');
      var who = (row.to && row.to.phoneMasked) || t('cloud.unnamed', 'Unnamed contact');
      info.appendChild(el('strong', null, who));
      info.appendChild(el('span', 'cloud-hint', row.kind === 'invitation'
        ? t('cloud.awaitingSignup', 'Waiting for them to sign in')
        : t('cloud.awaitingApproval', 'Waiting for their approval')));
      item.appendChild(info);
      card.appendChild(item);
    });
    return card;
  }

  function prefsCard() {
    var prefs = STATE.user.prefs || {};
    var card = el('div', 'cloud-card');
    card.appendChild(el('h3', 'cloud-title', t('cloud.prefsTitle', 'Consents')));
    card.appendChild(el('p', 'cloud-hint', t('cloud.prefsHint', 'Each consent is independent: alerts never imply location sharing or helper duty.')));

    var fields = [
      ['alertsFamily', t('cloud.prefAlerts', 'Alert my family in an emergency')],
      ['shareLocationOnEmergency', t('cloud.prefLocation', 'Share my location when I raise an emergency')],
      ['nearbyHelperOptIn', t('cloud.prefHelper', 'Let me act as a nearby helper')]
    ];
    var boxes = [];
    fields.forEach(function (entry) {
      var label = el('label', 'cloud-row');
      var box = el('input', 'field-check');
      box.type = 'checkbox';
      box.checked = !!prefs[entry[0]];
      box.addEventListener('change', function () {
        var patch = {};
        patch[entry[0]] = !!box.checked;
        boxes.forEach(function (b) { b.disabled = true; });
        // PATCH /v1/me { prefs: {...} } -> bare User
        api('/v1/me', { method: 'PATCH', body: { prefs: patch } })
          .then(function (data) {
            if (data && data.id) STATE.user = data;
            persistSession();
            setMessage('ok', t('cloud.prefsSaved', 'Preference saved.'));
          })
          .catch(function (err) {
            box.checked = !!prefs[entry[0]];
            setMessage('error', describeError(err));
          })
          .then(function () {
            boxes.forEach(function (b) { b.disabled = false; });
            render();
          });
      });
      boxes.push(box);
      label.appendChild(box);
      label.appendChild(el('span', 'cloud-grow', entry[1]));
      card.appendChild(label);
    });
    return card;
  }

  /* ---------- screenshot OCR ---------- */

  function ocrCard() {
    var hardware = bridge();
    var canOcr = !!(hardware && typeof hardware.pickScreenshotForOcr === 'function');
    var canRead = !!(hardware && typeof hardware.ocrImageFile === 'function');
    if (!canOcr && !canRead) return null;

    var card = el('div', 'cloud-card');
    card.appendChild(el('h3', 'cloud-title', t('cloud.ocrTitle', 'Scan a screenshot')));
    card.appendChild(el('p', 'cloud-hint', t('cloud.ocrHint', 'On-device text recognition. The image is processed locally and never uploaded.')));

    var out = el('textarea', 'field');
    out.rows = 4;
    out.placeholder = t('cloud.ocrPlaceholder', 'Extracted text appears here and is sent into the checker.');

    function fillWith(text) {
      out.value = text || '';
      if (text) setMessage('ok', t('cloud.ocrDone', 'Text extracted on device.'));
      else setMessage('error', t('cloud.ocrEmpty', 'No readable text found in that image.'));
      render();
    }

    if (canOcr) {
      var pick = el('button', 'btn btn-primary', t('cloud.chooseScreenshot', 'Choose screenshot'));
      pick.type = 'button';
      pick.addEventListener('click', function () {
        pick.disabled = true;
        var text = callNative('pickScreenshotForOcr');
        if (text === '__OCR_CANCELLED__') {
          setMessage(null, null);
        } else if (typeof text === 'string' && text.indexOf('__OCR_ERROR__:') === 0) {
          setMessage('error', text.slice('__OCR_ERROR__:'.length));
        } else if (typeof text === 'string' && text.length) {
          fillWith(text);
        } else {
          setMessage('error', t('cloud.ocrUnsupported', 'This device could not read that image. You can paste the text manually.'));
        }
        pick.disabled = false;
      });
      card.appendChild(pick);
    }

    var path = el('input', 'field');
    path.type = 'text';
    path.placeholder = t('cloud.ocrPath', 'Absolute image path');
    path.value = STATE.ocrPath;
    var run = el('button', 'btn', t('cloud.extract', 'Extract text'));
    run.type = 'button';
    run.addEventListener('click', function () {
      var value = path.value.trim();
      STATE.ocrPath = value;
      if (!value) {
        setMessage('error', t('cloud.ocrPathRequired', 'Enter the full path of a screenshot on this device.'));
        render();
        return;
      }
      if (!canRead) {
        setMessage('error', t('cloud.ocrUnsupported', 'This device could not read that image. You can paste the text manually.'));
        render();
        return;
      }
      run.disabled = true;
      var text = callNative('ocrImageFile', [value]);
      if (typeof text === 'string' && text.indexOf('__OCR_ERROR__:') === 0) {
        setMessage('error', text.slice('__OCR_ERROR__:'.length));
      } else if (typeof text === 'string' && text.length) {
        fillWith(text);
      } else {
        setMessage('error', t('cloud.ocrEmpty', 'No readable text found in that image.'));
      }
      run.disabled = false;
      render();
    });
    card.appendChild(path);
    card.appendChild(run);
    card.appendChild(out);

    var send = el('button', 'btn', t('cloud.ocrToChecker', 'Use in checker'));
    send.type = 'button';
    send.addEventListener('click', function () {
      var text = out.value.trim();
      if (!text) return;
      if (FS.app && typeof FS.app.analyzeText === 'function') FS.app.analyzeText(text);
      else if (typeof window.fsAnalyzeText === 'function') window.fsAnalyzeText(text);
    });
    card.appendChild(send);
    return card;
  }

  /* ---------- rendering ---------- */

  function mount() {
    return doc.getElementById('cloud-root');
  }

  function render() {
    var root = mount();
    if (!root) return;
    root.textContent = '';

    if (STATE.message) {
      var msg = el('div', 'cloud-message cloud-' + STATE.message.kind, STATE.message.text);
      msg.setAttribute('role', STATE.message.kind === 'error' ? 'alert' : 'status');
      root.appendChild(msg);
    }

    if (!STATE.user) {
      root.appendChild(authCard());
      var guestOcr = ocrCard();
      if (guestOcr) root.appendChild(guestOcr);
      return;
    }

    root.appendChild(accountCard());
    var inbox = inboxCard();
    if (inbox) root.appendChild(inbox);
    root.appendChild(consentList());
    root.appendChild(inviteCard());
    var outbox = outgoingCard();
    if (outbox) root.appendChild(outbox);
    root.appendChild(prefsCard());
    var ocr = ocrCard();
    if (ocr) root.appendChild(ocr);
  }

  function refresh() {
    if (!STATE.token) return Promise.resolve();
    // GET /v1/me -> bare User; GET /v1/family -> { incoming, outgoing, connections }
    return Promise.all([
      api('/v1/me'),
      api('/v1/family')
    ]).then(function (results) {
      var me = results[0] || {};
      STATE.user = me && me.id ? me : STATE.user;
      var family = results[1] || {};
      STATE.connections = family.connections || [];
      STATE.incoming = family.incoming || [];
      STATE.outgoing = family.outgoing || [];
      persistSession();
      render();
    }).catch(function (err) {
      setMessage('error', describeError(err));
      render();
    });
  }

  function accountVisible() {
    var view = doc.getElementById('view-account');
    return !!(view && view.classList.contains('is-active'));
  }

  /* Server state is only fetched while the account view is on screen, so the
   * app never calls the network at boot and someone who never opens this tab
   * sees no connection errors. */
  function hydrate(force) {
    if (!STATE.token) return Promise.resolve();
    if (!force && Date.now() - hydratedAt < HYDRATE_TTL) {
      render();
      return Promise.resolve();
    }
    hydratedAt = Date.now();
    return refresh().then(function () {
      if (!STATE.user) return;
      setMessage(null, null);
      render();
    });
  }

  var hydratedAt = 0;
  var HYDRATE_TTL = 30 * 1000;
  var booted = false;

  function init() {
    if (!mount() || booted) return;
    booted = true;
    restoreSession();
    // A restored session must re-attach this device to the account: the FCM
    // token survives app restarts, the server-side binding may not.
    if (STATE.token) syncPush();
    render();
    if (accountVisible()) hydrate(true);
  }

  /* Called by app.js navigation for every view change. */
  // Public surface used by the emergency, helper and OCR modules. `api` is the
  // single authenticated fetch path, so those modules never re-implement auth
  // or the FS_BASE/native-base resolution.
  Cloud.api = api;
  Cloud.baseUrl = baseUrl;
  Cloud.currentUser = function () { return STATE.user; };
  Cloud.setUser = function (user) { STATE.user = user; };

  Cloud.onView = function (view) {
    if (view !== 'account' || !mount()) return;
    render();
    hydrate(false);
  };

  Cloud.init = init;
  Cloud.refresh = refresh;
  Cloud.hydrate = hydrate;
  Cloud.state = STATE;

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
