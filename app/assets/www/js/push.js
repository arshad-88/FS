/* FamilyShield — device push registration.
 *
 * cloud.js calls FS.push.sync() after login/session restore and FS.push.signOut()
 * on logout. This module owns the client half of that contract: read the device
 * token from the Android bridge, register it against the signed-in account, rotate
 * it when it changes, and release it on logout.
 *
 * Native contract (MainActivity / FCM service on the Java side):
 *   Bridge.getFcmToken()            -> String   current token, '' when none
 *   FS.push.onNativeToken(token)    <- fires from onNewToken()/getToken(); ''
 *                                      means "this device has no token now"
 *   FS.push.openTargetFor(target)   <- fires on notification tap; target may be
 *                                      '#helper/abc', 'helper/abc', a click_action
 *                                      ('com.familyshield.app.EMERGENCY_ALERT'),
 *                                      a data.type ('family_emergency') or a URL.
 * Both callbacks are safe to call before boot(); the state machine below is the
 * only owner of registration, so an early push is stored and acted on at boot.
 *
 * Honesty rules baked in here:
 *  - A token is only ever read from the native bridge or from the native agent's
 *    push. There is no client-side generation and no placeholder value, because a
 *    fabricated token would make the server record a device that can never
 *    receive anything.
 *  - When the installed APK was built without Firebase, the bridge has no
 *    getFcmToken() method at all. We report 'unsupported' and send no request,
 *    rather than showing a "registered" state that does not exist.
 *  - Neither successful registration nor a 200 from the server is treated as
 *    proof of delivery. Registration only means "this device wants alerts".
 */
(function () {
  'use strict';

  var FS = window.FS = window.FS || {};
  var push = FS.push = FS.push || {};

  var ENDPOINT = '/v1/devices';
  var STORAGE_KEY = 'fs.push.token';
  var MAX_RETRIES = 5;
  var RETRY_BASE_MS = 2000;
  var RETRY_CAP_MS = 30000;

  /* FCM registration tokens are long opaque strings. Anything outside this window
   * is a stub, a log line or a serialised object, not a token. */
  var TOKEN_MIN = 8;
  var TOKEN_MAX = 4096;
  var NOT_A_TOKEN = { 'null': 1, 'undefined': 1, 'nil': 1, 'none': 1, 'false': 1, 'true': 1, '0': 1 };

  /* Idle -> no attempt yet. Registering -> request in flight. Registered ->
   * server accepted this token for this account. Unsupported -> build has no
   * FCM, so nothing can be registered. Failed -> attempt failed, retry pending
   * or exhausted (reason in `state.reason`: 'retrying', 'retries-exhausted',
   * 'no-token', 'not-signed-in', 'request-failed', 'awaiting-sign-in'). */
  var state = {
    status: 'idle',
    token: null,
    reason: null,
    retries: 0,
    inFlight: null,
    timer: null
  };

  push.state = state;

  /* ---------- storage ---------- */

  function storedToken() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) || '';
    } catch (err) {
      return '';
    }
  }

  function storeToken(token) {
    try {
      if (token) window.localStorage.setItem(STORAGE_KEY, token);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      /* Private mode or a cleared profile: registration still works this run. */
    }
  }

  /* ---------- native bridge ---------- */

  /* Most recent token the native agent pushed, and whether it told us FCM dropped
   * the token we held. Kept outside `state` because it survives sign-out: the
   * device token belongs to the install, not to the account. */
  var deviceToken = '';
  var revoked = false;

  /* Resolve the bridge exactly the way cloud.js does, so a build that exposes
   * the object under a different name is not misreported as 'unsupported'. */
  function bridge() {
    var b = window.FS.android || window.FSAndroid || window.AndroidBridge || null;
    if (!b) return null;
    try {
      if (typeof b.isFamilyShieldBridge === 'function' && !b.isFamilyShieldBridge()) return null;
    } catch (err) {
      return null;
    }
    return b;
  }

  /** True only when the installed build can actually produce an FCM token. */
  push.supported = function supported() {
    /* A token that already arrived is proof of its own existence, even if the
     * method disappeared from the bridge surface. */
    if (deviceToken) return true;
    var b = bridge();
    return !!(b && typeof b.getFcmToken === 'function');
  };

  /** Coerce whatever the bridge or the native agent handed us into a token or ''. */
  function normalizeToken(value) {
    if (value && typeof value === 'object') {
      /* Some bridge wrappers hand back a JSON-ish object instead of a String. */
      value = value.token || value.value || value.data || '';
    }
    if (typeof value !== 'string') return '';
    var token = value.replace(/^\s+|\s+$/g, '');
    if (!token) return '';
    if (NOT_A_TOKEN[token.toLowerCase()]) return '';
    if (/\s/.test(token)) return '';
    if (token.length < TOKEN_MIN || token.length > TOKEN_MAX) return '';
    return token;
  }

  function readToken() {
    var fromBridge = '';
    var b = bridge();
    if (b && typeof b.getFcmToken === 'function') {
      try {
        fromBridge = normalizeToken(b.getFcmToken());
      } catch (err) {
        fromBridge = '';
      }
    }
    /* An explicit push outranks a bridge read: onNewToken() fires the moment FCM
     * rotates a token, while getFcmToken() may still return the cached old one. */
    if (deviceToken) return deviceToken;
    /* Native said the token is gone. Registering the stale bridge value would
     * recreate a device row that can never receive anything. */
    if (revoked) return '';
    return fromBridge;
  }

  /**
   * Native token channel. Call from onNewToken(), from getToken() completion, and
   * with '' when FCM reports the token invalidated.
   * Returns the token that is now in force ('' when none).
   */
  push.onNativeToken = function onNativeToken(value) {
    var token = normalizeToken(value);
    var previous = deviceToken;

    if (!token) {
      deviceToken = '';
      if (!previous) {
        /* An empty push on a device that never had a token is just "not yet";
         * it must not wedge the bridge path for the rest of the session. */
        return '';
      }
      revoked = true;
      state.retries = 0;
      clearTimeout(state.timer);
      state.timer = null;
      if (state.status === 'registered') {
        /* The server is holding a token that no longer exists. */
        unregister(previous).catch(function () {});
        state.token = null;
        storeToken('');
      }
      state.status = 'failed';
      state.reason = 'no-token';
      emit();
      return '';
    }

    revoked = false;
    deviceToken = token;

    if (state.status === 'registered' && state.token === token) {
      /* Same token we already registered — nothing to send. */
      return token;
    }

    if (previous && previous !== token) {
      /* Rotation. sync()'s rotation path still finds the old token in storage and
       * releases it, so no extra request is needed here. */
      state.retries = 0;
    }

    if (signedInHint()) {
      push.sync();
    } else {
      /* Hold it: cloud.js calls sync() once the session appears. */
      state.status = 'idle';
      state.reason = 'awaiting-sign-in';
      emit();
    }
    return token;
  };

  /* ---------- server calls ---------- */

  function api() {
    return window.FS && window.FS.cloud && typeof window.FS.cloud.api === 'function'
      ? window.FS.cloud.api
      : null;
  }

  function register(token) {
    var call = api();
    if (!call) return Promise.reject(new Error('cloud module unavailable'));
    /* Ownership is proven by the session, never by the body: the server binds
     * the token to whoever is authenticated on this request. api() serialises
     * options.body itself, so this must stay a plain object. */
    return call(ENDPOINT, {
      method: 'POST',
      body: { token: token, platform: 'android' }
    });
  }

  function unregister(token) {
    var call = api();
    if (!call) return Promise.reject(new Error('cloud module unavailable'));
    /* Same body contract as register(): a plain object, serialised once. */
    return call(ENDPOINT, {
      method: 'DELETE',
      body: { token: token }
    });
  }

  function isAuthError(err) {
    return !!(err && (err.status === 401 || err.status === 403));
  }

  function retryable(err) {
    /* Network failures and 5xx are worth another attempt. A rejected token or
     * an expired session is not: retrying cannot fix either. */
    if (isAuthError(err)) return false;
    if (!err) return true;
    if (typeof err.status === 'number') return err.status >= 500 || err.status === 429;
    return true;
  }

  function scheduleRetry(token) {
    if (state.retries >= MAX_RETRIES) {
      state.status = 'failed';
      state.reason = 'retries-exhausted';
      return;
    }
    var delay = Math.min(RETRY_BASE_MS * Math.pow(2, state.retries), RETRY_CAP_MS);
    state.retries += 1;
    state.status = 'failed';
    state.reason = 'retrying';
    clearTimeout(state.timer);
    state.timer = setTimeout(function () {
      state.timer = null;
      push.sync();
    }, delay);
    /* A pending retry for a token we no longer hold is useless. */
    if (token && token !== readToken()) clearTimeout(state.timer);
  }

  function emit() {
    try {
      window.dispatchEvent(new CustomEvent('fs:push', {
        detail: { status: state.status, reason: state.reason }
      }));
    } catch (err) {
      /* Older WebViews without CustomEvent: status is still readable directly. */
    }
  }

  /* ---------- public flow ---------- */

  /**
   * Register the current device token for the signed-in account.
   * Safe to call repeatedly: a token already registered in this session is
   * skipped, and concurrent calls share one request.
   */
  push.sync = function sync() {
    if (state.inFlight) return state.inFlight;

    if (!push.supported()) {
      /* No Firebase in this build. Say so instead of pretending to register. */
      state.status = 'unsupported';
      state.reason = 'firebase-not-in-build';
      emit();
      return Promise.resolve(state.status);
    }

    var token = readToken();
    if (!token) {
      state.status = 'failed';
      state.reason = 'no-token';
      emit();
      return Promise.resolve(state.status);
    }

    if (state.status === 'registered' && state.token === token) {
      return Promise.resolve(state.status);
    }

    var previous = storedToken();
    state.status = 'registering';
    state.reason = null;
    emit();

    state.inFlight = register(token)
      .then(function () {
        state.token = token;
        state.status = 'registered';
        state.reason = null;
        state.retries = 0;
        storeToken(token);
        /* Rotation: drop the superseded token so the account does not collect
         * dead devices. Best effort — a failure here costs nothing at runtime. */
        if (previous && previous !== token) {
          unregister(previous).catch(function () {});
        }
        emit();
        return state.status;
      })
      .catch(function (err) {
        state.token = null;
        state.reason = isAuthError(err) ? 'not-signed-in' : 'request-failed';
        if (isAuthError(err)) {
          /* Session is gone; keep the token locally so the next sign-in retries. */
          state.status = 'failed';
          emit();
        } else if (retryable(err)) {
          scheduleRetry(token);
          emit();
        } else {
          state.status = 'failed';
          emit();
        }
        return state.status;
      })
      .then(function (status) {
        state.inFlight = null;
        return status;
      });

    return state.inFlight;
  };

  /**
   * Detach this device on logout. The local record is cleared first so a failed
   * request can never leave a stale token that a later account inherits.
   */
  push.signOut = function signOut() {
    clearTimeout(state.timer);
    state.timer = null;
    var token = storedToken() || state.token || '';
    state.status = 'idle';
    state.token = null;
    state.reason = null;
    state.retries = 0;
    state.inFlight = null;
    storeToken('');
    emit();

    if (!token) return Promise.resolve();
    /* Requires a live session; cloud.js calls this around its own logout, so a
     * 401 here is expected and simply means the row expires server-side. */
    return unregister(token).catch(function () {});
  };

  /* ---------- notification deep link ---------- */

  /* Payload spellings -> one key. The data payload uses type ('family_emergency',
   * 'helper_request'); the notification uses click_action
   * ('com.familyshield.app.EMERGENCY_ALERT'); the in-app format is '#kind/id'. */
  var ALIASES = {
    /* emergency alerts */
    emergency: 'emergency',
    sos: 'emergency',
    alert: 'emergency',
    'family-emergency': 'emergency',
    'family_emergency': 'emergency',
    'emergency-alert': 'emergency',
    'emergency_alert': 'emergency',
    /* helper / nearby requests */
    helper: 'helper',
    'helper-request': 'helper',
    'helper_request': 'helper',
    nearby: 'helper',
    /* plain destinations */
    family: 'family',
    'family-request': 'family',
    'family_request': 'family',
    history: 'history',
    account: 'account',
    profile: 'account',
    settings: 'settings',
    guide: 'guide',
    tips: 'guide',
    scan: 'scan',
    home: 'scan',
    check: 'scan',
    result: 'result',
    results: 'result'
  };

  /* key -> what to open. `module`/`refresh` re-pull server state before the panel
   * is shown; `panel` is the surface a tap must land on, not the tab top. */
  var ROUTES = {
    emergency: { view: 'scan', module: 'sos', refresh: 'refresh', panel: '#sos-root' },
    helper: { view: 'scan', module: 'helper', refresh: 'refresh', force: true, panel: '#helper-root' },
    family: { view: 'family' },
    history: { view: 'history' },
    /* The account panel lives inside the settings view (#view-settings). */
    account: { view: 'settings' },
    settings: { view: 'settings' },
    guide: { view: 'guide' },
    scan: { view: 'scan' },
    result: { view: 'result' }
  };

  function targetText(raw) {
    if (raw === null || raw === undefined) return '';
    if (typeof raw === 'object') {
      var fields = ['target', 'hash', 'url', 'link', 'click_action', 'clickAction', 'type'];
      for (var i = 0; i < fields.length; i++) {
        if (typeof raw[fields[i]] === 'string' && raw[fields[i]]) return raw[fields[i]];
      }
      return '';
    }
    return String(raw);
  }

  /**
   * Fold any target spelling onto a key from ALIASES, or '' when it names nothing
   * we can show. Never guesses: an unknown target opens nothing rather than
   * dropping the user on a random tab.
   */
  function targetKey(raw) {
    var text = targetText(raw).replace(/^\s+|\s+$/g, '');
    if (!text) return '';
    var hash = text.indexOf('#');
    if (hash >= 0) {
      /* '#helper/abc' or 'file:///.../index.html#family/12' */
      text = text.slice(hash + 1);
    } else if (/^[a-z][a-z0-9+.\-]*:/i.test(text)) {
      /* 'intent:...', 'https://host/' with no fragment: no surface named. */
      return '';
    }
    text = text.replace(/^[#\/]+/, '');
    var stop = text.search(/[\/?&=;#]/);
    if (stop === 0) return '';
    if (stop > 0) text = text.slice(0, stop);
    text = text.toLowerCase();
    /* 'com.familyshield.app.EMERGENCY_ALERT' -> 'emergency_alert' */
    if (text.indexOf('.') >= 0) text = text.split('.').pop();
    return ALIASES[text] || '';
  }

  /* Target that arrived before the router existed; applied once at boot. */
  var pendingTarget = null;
  var lastRoute = { key: '', at: 0 };

  function routerReady() {
    var app = window.FS && window.FS.app;
    return !!(app && typeof app.go === 'function');
  }

  /* Which view the router has actually switched to. Used to verify that a tap
   * really landed somewhere instead of reporting a navigation that did not
   * happen. */
  function activeView() {
    var node = document.querySelector('.view.is-active');
    return node ? String(node.getAttribute('data-view') || '') : '';
  }

  function goTo(view) {
    var app = window.FS && window.FS.app;
    if (app && typeof app.go === 'function') {
      app.go(view);
      /* App.go() returns silently for a view the markup does not contain. */
      return activeView() === view;
    }
    var tab = document.querySelector('.tabbar__item[data-nav="' + view + '"]');
    if (!tab) return false;
    tab.click();
    return activeView() === view;
  }

  function reveal(selector) {
    var node = document.querySelector(selector);
    if (!node) return false;
    if (typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    return true;
  }

  function applyTarget(raw) {
    var key = targetKey(raw);
    if (!key || !ROUTES[key]) return false;

    /* Before the app module is up there is no tab to switch to; hold the target
     * and let boot() apply it instead of losing the tap. */
    if (!routerReady()) {
      pendingTarget = raw;
      return true;
    }

    var route = ROUTES[key];
    var now = Date.now();
    /* The same tap can reach us twice (hash + openTargetFor, or a replayed
     * intent). Re-running it would reset scroll and re-hit the server. */
    if (key === lastRoute.key && now - lastRoute.at < 750) return true;

    if (!goTo(route.view)) return false;
    lastRoute.key = key;
    lastRoute.at = now;

    /* Refresh the owning module so the panel shows server state, then bring it
     * into view — a notification must land on the request, not on a tab top. */
    var fs = window.FS || {};
    var settled = null;
    if (route.module) {
      var mod = fs[route.module];
      if (mod && typeof mod[route.refresh] === 'function') {
        try {
          settled = route.force ? mod[route.refresh](true) : mod[route.refresh]();
        } catch (err) {
          settled = null;
        }
      }
    }
    if (route.panel) {
      reveal(route.panel);
      /* The panel grows once the server answers; scroll again when it does so
       * the target is still at the top of the screen. */
      if (settled && typeof settled.then === 'function') {
        var panel = route.panel;
        settled.then(function () { reveal(panel); }, function () { reveal(panel); });
      }
    }
    return true;
  }

  /**
   * Native entry point for a notification tap. Accepts any target spelling
   * targetKey() understands; returns true when the tap was taken (routed, or
   * queued for boot), false when the target names no surface.
   */
  push.openTargetFor = function openTargetFor(target) {
    return applyTarget(target);
  };

  /**
   * Open the surface named by the launch hash (window.location.hash, format
   * '#kind/id'), or by an explicit target when one is passed.
   * Navigation reuses the app's own router so there is one code path.
   */
  push.openTarget = function openTarget(target) {
    if (target !== undefined && target !== null) return applyTarget(target);
    var raw = '';
    try {
      raw = String(window.location.hash || '');
    } catch (err) {
      return false;
    }
    return applyTarget(raw);
  };

  /* A tap while the WebView is already alive only changes the hash. */
  window.addEventListener('hashchange', function () {
    push.openTarget();
  });

  /* ---------- lifecycle ---------- */

  function signedInHint() {
    var cloud = window.FS && window.FS.cloud;
    if (!cloud) return false;
    var s = cloud.state;
    if (s && s.token) return true;
    /* Some builds keep the session on the module itself. */
    return !!(cloud.token || cloud.sessionToken);
  }

  function boot() {
    /* cloud.js already calls sync() right after login and on session restore;
     * this only covers a cold start where that call was skipped because the
     * WebView loaded before the session was restored. */
    if (signedInHint() && state.status === 'idle') push.sync();

    if (pendingTarget !== null && pendingTarget !== undefined) {
      var queued = pendingTarget;
      pendingTarget = null;
      applyTarget(queued);
    }
    push.openTarget();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* Returning from the background is the natural moment to retry a failed
   * registration or pick up a rotated token. */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (!signedInHint()) return;
    if (state.status === 'registered' && state.token === readToken()) return;
    if (state.status === 'unsupported') return;
    push.sync();
  });
})();
