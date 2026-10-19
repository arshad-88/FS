/* FamilyShield — nearby helper duty (the "someone near you needs help" side).
 * Contract: docs/API.md §4 "Nearby helpers" —
 *   GET  /v1/helper/assignments                 -> { assignments: [...] }
 *   POST /v1/helper/assignments/:id/accept      -> { assignment } (exact lat/lng only now)
 *   POST /v1/helper/assignments/:id/decline     -> { assignment }
 *
 * Non-negotiable behaviour:
 *   - Every network call goes through FS.cloud.api; this file never builds a URL
 *     or an Authorization header itself.
 *   - Nothing is rendered for signed-out visitors: sos.js already asks them to
 *     sign in once, and a second prompt on the same screen is noise.
 *   - Helper duty is opt-in (user.prefs.nearbyHelperOptIn). Off means no polling,
 *     no requests, no location.
 *   - Accept/decline are explicit taps only. There is no auto-accept and no
 *     auto-decline; local state only changes after the server confirms, and a
 *     409/404 removes the row instead of pretending it worked.
 *   - Exact coordinates are shown only when the server marks the assignment
 *     `precise`; before that the card says the location is approximate.
 *   - A failed call never looks like success: the error copy says plainly that
 *     nothing changed.
 */
(function () {
  'use strict';

  var FS = window.FS || (window.FS = {});
  var Helper = FS.helper || (FS.helper = {});
  var doc = document;

  var POLL_MS = 20000;
  var NOTE_MAX = 240;

  var STATE = {
    assignments: [],
    loading: false,
    loaded: false,
    unavailable: false,
    busyId: null,
    error: '',
    notice: '',
    poll: null,
    seq: 0
  };

  /* ---------- small helpers ---------- */

  function t(key, fallback, params) {
    var value = key;
    if (FS.app && typeof FS.app.t === 'function') {
      var translated = FS.app.t(key, params);
      if (translated && translated !== key) return translated;
    }
    if (fallback != null) value = fallback;
    if (params) {
      Object.keys(params).forEach(function (name) {
        value = value.split('{' + name + '}').join(String(params[name]));
      });
    }
    return value;
  }

  function api(path, options) {
    if (!FS.cloud || typeof FS.cloud.api !== 'function') {
      var missing = new Error('cloud api unavailable');
      missing.code = 'no_backend';
      return Promise.reject(missing);
    }
    return FS.cloud.api(path, options);
  }

  function signedIn() {
    return !!(FS.cloud && typeof FS.cloud.currentUser === 'function' && FS.cloud.currentUser());
  }

  function prefs() {
    var user = signedIn() ? FS.cloud.currentUser() : null;
    var bag = user && user.prefs;
    return bag && typeof bag === 'object' ? bag : {};
  }

  function optedIn() {
    return prefs().nearbyHelperOptIn === true;
  }

  function el(id) {
    return doc.getElementById(id);
  }

  function node(tag, className, text) {
    var n = doc.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function toNumber(value) {
    if (typeof value === 'number' && isFinite(value)) return value;
    if (typeof value === 'string' && value !== '') {
      var parsed = parseFloat(value);
      if (isFinite(parsed)) return parsed;
    }
    return null;
  }

  function scanVisible() {
    var view = el('view-scan');
    return !!(view && view.classList.contains('is-active'));
  }

  /* ---------- timer ---------- */

  function stopPolling() {
    if (STATE.poll) {
      clearInterval(STATE.poll);
      STATE.poll = null;
    }
  }

  function startPolling() {
    stopPolling();
    // A load can resolve after the user navigated away: never leave a timer
    // running behind a hidden view.
    if (!signedIn() || !optedIn() || STATE.unavailable || !scanVisible()) return;
    STATE.poll = setInterval(function () {
      if (doc.hidden || !scanVisible()) return;
      load({ quiet: true });
    }, POLL_MS);
  }

  /* ---------- presence (the outbound half of nearby matching) ---------- */

  // POST /v1/helper/location keeps this helper inside the server's matching pool.
  // The server drops locations older than 30 minutes, so a live duty shift has
  // to refresh well inside that window. Nothing is sent while duty is off, while
  // signed out, or while the app is in the background.
  var PRESENCE_MS = 2 * 60 * 1000;
  var PRESENCE_RETRY_MS = 45 * 1000;

  var presence = {
    timer: null,
    at: 0,
    busy: false,
    blocked: false,
    failures: 0
  };

  function canPublishPresence() {
    return signedIn() && optedIn() && !doc.hidden &&
      !!(FS.geo && typeof FS.geo.getLocation === 'function');
  }

  function stopPresence() {
    if (presence.timer) {
      clearTimeout(presence.timer);
      presence.timer = null;
    }
  }

  function schedulePresence() {
    stopPresence();
    if (!canPublishPresence() || presence.blocked) return;
    var wait = presence.failures > 0 ? PRESENCE_RETRY_MS : PRESENCE_MS;
    presence.timer = setTimeout(function () {
      presence.timer = null;
      publishPresence();
    }, wait);
  }

  function publishPresence() {
    if (!canPublishPresence() || presence.blocked) return Promise.resolve();
    if (presence.busy) return Promise.resolve();
    presence.busy = true;

    return FS.geo.getLocation({ timeout: 12000, maximumAge: PRESENCE_MS }).then(
      function (fix) {
        var lat = fix && toNumber(fix.lat);
        var lng = fix && toNumber(fix.lon != null ? fix.lon : fix.lng);
        if (lat === null || lng === null) throw new Error('no fix');
        if (!canPublishPresence()) return null; // consent or visibility changed mid-fix
        var location = { lat: lat, lng: lng, ageSeconds: 0 };
        var accuracy = toNumber(fix.accuracy);
        if (accuracy !== null && accuracy >= 0) location.accuracyM = Math.round(accuracy);
        return api('/v1/helper/location', { method: 'POST', body: { location: location } });
      }
    ).then(
      function () {
        presence.at = Date.now();
        presence.failures = 0;
      },
      function (err) {
        // A denial and a server-side opt-out are both answers: stop asking until
        // the user acts again. Network noise just retries quietly.
        var denied = err && (
          err.code === 1 || err.code === 'not_opted_in' || err.status === 403 ||
          err.error === 'denied' || err.name === 'PermissionDeniedError'
        );
        if (denied) presence.blocked = true;
        presence.failures += 1;
      }
    ).then(function () {
      presence.busy = false;
      schedulePresence();
    });
  }

  /* ---------- assignment list ---------- */

  function isActive(entry) {
    return !!entry && (entry.status === 'pending' || entry.status === 'accepted');
  }

  function normalize(list) {
    var out = [];
    if (!list || typeof list.length !== 'number') return out;
    for (var i = 0; i < list.length; i += 1) {
      var entry = list[i];
      if (!entry || !entry.id || !isActive(entry)) continue;
      out.push(entry);
    }
    return out;
  }

  function byStatus(status) {
    var out = [];
    for (var i = 0; i < STATE.assignments.length; i += 1) {
      if (STATE.assignments[i].status === status) out.push(STATE.assignments[i]);
    }
    return out;
  }

  function find(id) {
    for (var i = 0; i < STATE.assignments.length; i += 1) {
      if (STATE.assignments[i].id === id) return STATE.assignments[i];
    }
    return null;
  }

  function removeLocal(id) {
    var kept = [];
    for (var i = 0; i < STATE.assignments.length; i += 1) {
      if (STATE.assignments[i].id !== id) kept.push(STATE.assignments[i]);
    }
    STATE.assignments = kept;
  }

  function adopt(updated) {
    if (!updated || !updated.id) return;
    removeLocal(updated.id);
    if (isActive(updated)) STATE.assignments = STATE.assignments.concat([updated]);
  }

  /* ---------- formatting ---------- */

  function distanceText(entry) {
    var metres = toNumber(entry && entry.distanceM);
    if (metres === null) metres = toNumber(entry && entry.request && entry.request.distanceM);
    if (metres === null) return '';
    metres = Math.max(0, Math.round(metres));
    if (metres < 1000) {
      return t('helper.distanceM', '{n} m away', { n: Math.max(1, metres) });
    }
    return t('helper.distanceKm', '{n} km away', { n: (metres / 1000).toFixed(1) });
  }

  function ageText(entry) {
    var seconds = toNumber(entry && entry.ageSeconds);
    if (seconds === null) {
      var req = (entry && entry.request) || {};
      var iso = (entry && entry.createdAt) || req.createdAt;
      var ms = iso ? Date.parse(iso) : NaN;
      if (isFinite(ms)) seconds = Math.max(0, (Date.now() - ms) / 1000);
    }
    if (seconds === null) return '';
    if (seconds < 90) return t('helper.justNow', 'just now');
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return t('helper.minutesAgo', '{n} min ago', { n: Math.max(1, minutes) });
    var hours = Math.round(minutes / 60);
    return t('helper.hoursAgo', '{n} h ago', { n: Math.max(1, hours) });
  }

  function preciseOf(entry) {
    var req = (entry && entry.request) || {};
    return req.precise === true || (entry && entry.precise === true);
  }

  // Coordinates are only ever present once the server says precise:true.
  function coordsOf(entry) {
    if (!preciseOf(entry)) return null;
    var req = (entry && entry.request) || {};
    var lat = toNumber(req.lat != null ? req.lat : req.latitude);
    var lngRaw = req.lng != null ? req.lng : (req.longitude != null ? req.longitude : req.lon);
    var lng = toNumber(lngRaw);
    if (lat === null || lng === null) {
      lat = toNumber(entry && entry.lat);
      lng = toNumber(entry && entry.lng);
    }
    if (lat === null || lng === null) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat: lat, lng: lng };
  }

  function requesterOf(entry) {
    var req = (entry && entry.request) || {};
    var person = (entry && entry.requester) || req.requester || {};
    var name = person.displayName || person.name || req.displayName || '';
    return { name: String(name || ''), phone: person.phone || req.phone || '' };
  }

  /* ---------- errors ---------- */

  function errorText(err) {
    var status = err && err.status;
    var code = err && err.code;
    if (code === 'not_opted_in') return t('helper.notOptedIn', 'Helper duty is off in your Family account.');
    if (status === 429) return t('helper.rateLimited', 'Too many actions. Wait a moment and try again.');
    if (!status) return t('helper.offline', 'Could not reach the server. Nothing was changed.');
    return t('helper.errorGeneric', 'That did not work. Nothing was changed.');
  }

  function handleActionError(err, assignment, action) {
    var status = err && err.status;
    if (status === 401) {
      // cloud.api already cleared the session; render() hides this card.
      STATE.assignments = [];
      stopPolling();
      return;
    }
    if (status === 404) {
      removeLocal(assignment.id);
      STATE.error = t('helper.expired', 'This request is no longer active.');
      load({ quiet: true });
      return;
    }
    if (status === 409) {
      // state_conflict = the request ended; already_claimed = a faster helper won.
      removeLocal(assignment.id);
      STATE.error = err && err.code === 'state_conflict'
        ? t('helper.expired', 'This request is no longer active.')
        : t('helper.alreadyClaimed', 'Someone else accepted this request first.');
      load({ quiet: true });
      return;
    }
    STATE.error = errorText(err);
    if (action === 'accept' && err && err.code === 'not_opted_in') {
      // Server-side opt-out: trust it over the cached profile.
      STATE.assignments = [];
      stopPolling();
    }
  }

  /* ---------- read / write ---------- */

  function load(options) {
    options = options || {};
    if (!signedIn() || !optedIn()) {
      STATE.assignments = [];
      STATE.loading = false;
      STATE.loaded = false;
      STATE.unavailable = false;
      STATE.error = '';
      stopPolling();
      stopPresence();
      render();
      return Promise.resolve();
    }
    if (STATE.unavailable) return Promise.resolve();
    if (STATE.loading) return Promise.resolve();

    var seq = (STATE.seq += 1);
    STATE.loading = true;
    if (!options.quiet) render();

    return api('/v1/helper/assignments').then(
      function (data) {
        if (seq !== STATE.seq) return;
        STATE.loading = false;
        STATE.loaded = true;
        STATE.error = '';
        STATE.assignments = normalize(data && data.assignments);
        render();
        startPolling();
      },
      function (err) {
        if (seq !== STATE.seq) return;
        STATE.loading = false;
        STATE.loaded = true;
        if (err && err.status === 401) {
          STATE.assignments = [];
          stopPolling();
          render();
          return;
        }
        if (err && err.status === 404) {
          // Server build without the helper feature: stay quiet, stop asking.
          STATE.assignments = [];
          STATE.unavailable = true;
          stopPolling();
          stopPresence();
          render();
          return;
        }
        STATE.error = errorText(err);
        render();
        // Keep retrying on a timer: a dropped signal must not end the duty shift.
        startPolling();
      }
    );
  }

  function act(id, action) {
    var assignment = find(id);
    if (!assignment || STATE.busyId) return;
    STATE.busyId = id;
    STATE.error = '';
    STATE.notice = '';
    render();

    var verb = action === 'accept' ? 'accept' : 'decline';
    api('/v1/helper/assignments/' + encodeURIComponent(id) + '/' + verb, { method: 'POST', body: {} }).then(
      function (data) {
        STATE.busyId = null;
        var updated = data && data.assignment && data.assignment.id ? data.assignment : null;
        if (updated && data.requester && !updated.requester) updated.requester = data.requester;
        if (!updated) {
          updated = {};
          Object.keys(assignment).forEach(function (key) { updated[key] = assignment[key]; });
          updated.status = action === 'accept' ? 'accepted' : 'declined';
        }
        adopt(updated);
        STATE.notice = action === 'accept'
          ? t('helper.accepted', 'Accepted. Only the person who asked and you can see this.')
          : t('helper.declined', 'Marked as unable to help.');
        render();
        // Reconcile with the server so the badge is never just optimistic.
        load({ quiet: true });
      },
      function (err) {
        STATE.busyId = null;
        handleActionError(err, assignment, action);
        render();
      }
    );
  }

  function refresh(force) {
    return load({ quiet: !force });
  }

  // Called when consent or the session changes outside this module. Turning the
  // duty on arms presence right away instead of waiting for the scan tab, and
  // turning it off stops the fix loop. `blocked` is cleared so a permission the
  // user granted later can actually be retried.
  function syncPresence() {
    stopPresence();
    presence.blocked = false;
    if (!signedIn() || !optedIn()) {
      STATE.assignments = [];
      stopPolling();
      render();
      return Promise.resolve();
    }
    var work = doc.hidden ? Promise.resolve() : publishPresence();
    if (scanVisible()) load({ quiet: true });
    return work;
  }

  /* ---------- rendering ---------- */

  // Badge colours are honest: "Helping" is the committed state, a waiting
  // request is the urgent one, and plain duty is neutral rather than "safe".
  function pillFor(pending, accepted) {
    if (accepted.length) {
      return node('span', 'pill pill--safe tiny', t('helper.helpingPill', 'Helping'));
    }
    if (pending.length) {
      return node('span', 'pill pill--medium tiny', t('helper.pendingPill', '{n} waiting', { n: pending.length }));
    }
    return node('span', 'pill tiny', t('helper.onDuty', 'On duty'));
  }

  function optInCard() {
    var card = node('section', 'helper');
    card.setAttribute('data-helper-card', 'optin');

    var head = node('div', 'helper__head');
    head.appendChild(node('h2', 'helper__title', t('helper.offTitle', 'Be a nearby helper')));
    card.appendChild(head);

    card.appendChild(node('p', 'helper__body', t('helper.offBody',
      'Turn on helper duty in your Family account to be alerted when someone near you raises an SOS. Your location is never shared unless you accept.')));

    var actions = node('div', 'helper__actions');
    var open = node('button', 'btn btn--primary', t('helper.openAccount', 'Open Family account'));
    open.type = 'button';
    open.setAttribute('data-helper-action', 'open-account');
    open.addEventListener('click', function () {
      if (FS.app && typeof FS.app.go === 'function') FS.app.go('account');
    });
    actions.appendChild(open);
    card.appendChild(actions);
    return card;
  }

  function metaLine(entry) {
    var who = requesterOf(entry);
    var bits = [];
    if (who.name) bits.push(t('helper.requester', '{name} asked', { name: who.name }));
    else bits.push(t('helper.anonymous', 'A family nearby'));
    var age = ageText(entry);
    if (age) bits.push(age);
    return bits.join(' · ');
  }

  // The requester's note is human free text: quote it, never re-style it.
  function noteBlock(entry) {
    var req = (entry && entry.request) || {};
    var note = req.note;
    if (typeof note !== 'string' || !note.trim()) return null;
    return node('blockquote', 'helper__note', note.trim().slice(0, NOTE_MAX));
  }

  function pendingBlock(entry) {
    var block = node('li', 'helper helper--pending');
    block.setAttribute('data-helper-request', entry.id);
    block.setAttribute('data-helper-status', 'pending');

    var head = node('div', 'helper__head');
    head.appendChild(node('h3', 'helper__title', t('helper.requestTitle', 'SOS nearby')));
    var distance = distanceText(entry);
    if (distance) head.appendChild(node('span', 'helper__distance', distance));
    block.appendChild(head);

    block.appendChild(node('div', 'helper__meta', metaLine(entry)));
    var note = noteBlock(entry);
    if (note) block.appendChild(note);

    if (!preciseOf(entry)) {
      block.appendChild(node('p', 'helper__hint', t('helper.approxLocation',
        'The exact location is shared only after you accept.')));
    }

    var actions = node('div', 'helper__actions');
    var accept = node('button', 'btn btn--primary', t('helper.accept', 'I can help'));
    accept.type = 'button';
    accept.setAttribute('data-helper-action', 'accept');
    accept.disabled = !!STATE.busyId;
    accept.addEventListener('click', function () { act(entry.id, 'accept'); });

    var decline = node('button', 'btn btn--ghost', t('helper.decline', 'Not now'));
    decline.type = 'button';
    decline.setAttribute('data-helper-action', 'decline');
    decline.disabled = !!STATE.busyId;
    decline.addEventListener('click', function () { act(entry.id, 'decline'); });

    actions.appendChild(accept);
    actions.appendChild(decline);
    block.appendChild(actions);
    return block;
  }

  // Precise coordinates only ever arrive after an accept (API: precise:true).
  function acceptedBlock(entry) {
    var block = node('li', 'helper helper--accepted');
    block.setAttribute('data-helper-request', entry.id);
    block.setAttribute('data-helper-status', 'accepted');

    var head = node('div', 'helper__head');
    head.appendChild(node('h3', 'helper__title', t('helper.acceptedTitle', 'You are on the way')));
    var distance = distanceText(entry);
    if (distance) head.appendChild(node('span', 'helper__distance', distance));
    block.appendChild(head);

    block.appendChild(node('div', 'helper__meta', metaLine(entry)));

    var actions = node('div', 'helper__actions');
    var coords = coordsOf(entry);
    if (coords) {
      var lat = coords.lat.toFixed(5);
      var lng = coords.lng.toFixed(5);
      block.appendChild(node('p', 'helper__hint', t('helper.coords', 'Location {lat}, {lng}', { lat: lat, lng: lng })));
      var maps = node('a', 'btn btn--ghost', t('helper.openMaps', 'Open in maps'));
      maps.href = 'geo:' + lat + ',' + lng + '?q=' + lat + ',' + lng;
      maps.setAttribute('data-helper-action', 'maps');
      actions.appendChild(maps);
    }

    var who = requesterOf(entry);
    if (who.phone) {
      var shown = String(who.phone);
      // Server-masked numbers ("+91******1234") must not become a broken tel: link.
      if (shown.indexOf('*') !== -1 || shown.indexOf('•') !== -1) {
        block.appendChild(node('p', 'helper__hint', t('helper.phone', 'Phone {phone}', { phone: shown })));
      } else {
        var phone = node('a', 'btn btn--ghost', t('helper.phone', 'Phone {phone}', { phone: shown }));
        phone.href = 'tel:' + shown.replace(/[^\d+]/g, '');
        phone.setAttribute('data-helper-action', 'call-requester');
        actions.appendChild(phone);
      }
    }
    if (actions.firstChild) block.appendChild(actions);

    var note = noteBlock(entry);
    if (note) block.appendChild(note);
    return block;
  }

  function dutyCard(pending, accepted) {
    var card = node('section', 'helper');
    card.setAttribute('data-helper-card', 'duty');

    var head = node('div', 'helper__head');
    head.appendChild(node('h2', 'helper__title', t('helper.title', 'Nearby helper')));
    head.appendChild(pillFor(pending, accepted));
    card.appendChild(head);

    var body;
    if (accepted.length) {
      body = t('helper.acceptedBody', 'You accepted this request. Stay reachable, and call emergency services first if the situation is dangerous.');
    } else if (pending.length) {
      body = t('helper.pendingBody', 'Someone raised an SOS near you. Accept only if you can really go.');
    } else if (STATE.loading && !STATE.loaded) {
      body = t('helper.loading', 'Checking for requests…');
    } else {
      body = t('helper.idleBody', 'Helper duty is on. You will be alerted if an SOS is raised near you. Nothing is shared until you accept.');
    }
    card.appendChild(node('p', 'helper__body', body));

    if (STATE.error) {
      var alert = node('div', 'alert-box alert-box--warn small', STATE.error);
      alert.setAttribute('role', 'alert');
      card.appendChild(alert);
    }
    if (STATE.notice) {
      var notice = node('p', 'helper__hint', STATE.notice);
      notice.setAttribute('data-helper-notice', 'last');
      card.appendChild(notice);
    }

    var foot = node('div', 'helper__actions');
    var refreshBtn = node('button', 'btn btn--ghost', t('helper.refresh', 'Refresh'));
    refreshBtn.type = 'button';
    refreshBtn.setAttribute('data-helper-action', 'refresh');
    refreshBtn.disabled = !!STATE.loading;
    refreshBtn.addEventListener('click', function () { refresh(true); });
    foot.appendChild(refreshBtn);

    var settings = node('button', 'btn btn--link', t('helper.settings', 'Helper settings'));
    settings.type = 'button';
    settings.setAttribute('data-helper-action', 'open-account');
    settings.addEventListener('click', function () {
      if (FS.app && typeof FS.app.go === 'function') FS.app.go('account');
    });
    foot.appendChild(settings);
    card.appendChild(foot);

    return card;
  }

  function render() {
    var root = el('helper-root');
    if (!root) {
      stopPolling();
      return;
    }
    root.setAttribute('aria-busy', STATE.loading ? 'true' : 'false');
    root.textContent = '';

    if (!signedIn()) {
      stopPolling();
      return;
    }
    if (!optedIn()) {
      stopPolling();
      root.appendChild(optInCard());
      return;
    }
    if (STATE.unavailable) return;

    var pending = byStatus('pending');
    var accepted = byStatus('accepted');
    var frag = doc.createDocumentFragment();
    frag.appendChild(dutyCard(pending, accepted));

    if (pending.length || accepted.length) {
      var list = node('ul', 'helper__list');
      var i;
      for (i = 0; i < pending.length; i += 1) list.appendChild(pendingBlock(pending[i]));
      for (i = 0; i < accepted.length; i += 1) list.appendChild(acceptedBlock(accepted[i]));
      frag.appendChild(list);
    } else if (STATE.loaded) {
      frag.appendChild(node('p', 'helper__empty', t('helper.empty',
        'No one near you needs help right now. This card updates while the screen is open.')));
    }
    root.appendChild(frag);
  }

  /* ---------- strings ---------- */

  if (FS.i18n && typeof FS.i18n.addStrings === 'function') {
    FS.i18n.addStrings({
      en: {
        'helper.title': 'Nearby helper',
        'helper.offTitle': 'Be a nearby helper',
        'helper.offBody': 'Turn on helper duty in your Family account to be alerted when someone near you raises an SOS. Your location is never shared unless you accept.',
        'helper.openAccount': 'Open Family account',
        'helper.settings': 'Helper settings',
        'helper.onDuty': 'On duty',
        'helper.pendingPill': '{n} waiting',
        'helper.helpingPill': 'Helping',
        'helper.idleBody': 'Helper duty is on. You will be alerted if an SOS is raised near you. Nothing is shared until you accept.',
        'helper.pendingBody': 'Someone raised an SOS near you. Accept only if you can really go.',
        'helper.acceptedBody': 'You accepted this request. Stay reachable, and call emergency services first if the situation is dangerous.',
        'helper.requestTitle': 'SOS nearby',
        'helper.acceptedTitle': 'You are on the way',
        'helper.distanceM': '{n} m away',
        'helper.distanceKm': '{n} km away',
        'helper.justNow': 'just now',
        'helper.minutesAgo': '{n} min ago',
        'helper.hoursAgo': '{n} h ago',
        'helper.approxLocation': 'The exact location is shared only after you accept.',
        'helper.accept': 'I can help',
        'helper.decline': 'Not now',
        'helper.accepted': 'Accepted. Only the person who asked and you can see this.',
        'helper.declined': 'Marked as unable to help.',
        'helper.loading': 'Checking for requests…',
        'helper.refresh': 'Refresh',
        'helper.alreadyClaimed': 'Someone else accepted this request first.',
        'helper.expired': 'This request is no longer active.',
        'helper.notOptedIn': 'Helper duty is off in your Family account.',
        'helper.rateLimited': 'Too many actions. Wait a moment and try again.',
        'helper.offline': 'Could not reach the server. Nothing was changed.',
        'helper.errorGeneric': 'That did not work. Nothing was changed.',
        'helper.coords': 'Location {lat}, {lng}',
        'helper.openMaps': 'Open in maps',
        'helper.phone': 'Phone {phone}',
        'helper.note': 'Their note',
        'helper.requester': '{name} asked',
        'helper.anonymous': 'A family nearby',
        'helper.empty': 'No one near you needs help right now.'
      },
      hi: {
        'helper.title': 'आस-पास सहायक',
        'helper.offTitle': 'आस-पास के सहायक बनें',
        'helper.offBody': 'किसी आस-पास के व्यक्ति के SOS पर सूचना पाने के लिए फैमिली अकाउंट में सहायक ड्यूटी चालू करें। स्वीकार करने तक आपकी लोकेशन कभी साझा नहीं होती।',
        'helper.openAccount': 'फैमिली अकाउंट खोलें',
        'helper.settings': 'सहायक सेटिंग्स',
        'helper.onDuty': 'ड्यूटी पर',
        'helper.pendingPill': '{n} प्रतीक्षारत',
        'helper.helpingPill': 'मदद जारी',
        'helper.idleBody': 'सहायक ड्यूटी चालू है। आपके पास SOS होने पर सूचना मिलेगी। स्वीकार करने तक कुछ साझा नहीं होता।',
        'helper.pendingBody': 'आपके पास किसी ने SOS भेजा है। केवल तभी स्वीकार करें जब आप सचमुच जा सकें।',
        'helper.acceptedBody': 'आपने यह अनुरोध स्वीकार किया है। संपर्क में रहें; स्थिति खतरनाक हो तो पहले आपातकालीन सेवा को कॉल करें।',
        'helper.requestTitle': 'पास में SOS',
        'helper.acceptedTitle': 'आप रास्ते में हैं',
        'helper.distanceM': '{n} मीटर दूर',
        'helper.distanceKm': '{n} किमी दूर',
        'helper.justNow': 'अभी',
        'helper.minutesAgo': '{n} मिनट पहले',
        'helper.hoursAgo': '{n} घंटे पहले',
        'helper.approxLocation': 'सटीक लोकेशन स्वीकार करने के बाद ही साझा होती है।',
        'helper.accept': 'मैं मदद कर सकता/सकती हूँ',
        'helper.decline': 'अभी नहीं',
        'helper.accepted': 'स्वीकार किया गया। यह केवल आपको और अनुरोध करने वाले को दिखता है।',
        'helper.declined': 'मदद न कर पाने के रूप में चिह्नित किया गया।',
        'helper.loading': 'अनुरोध देखे जा रहे हैं…',
        'helper.refresh': 'रीफ़्रेश',
        'helper.alreadyClaimed': 'यह अनुरोध किसी और ने पहले स्वीकार कर लिया।',
        'helper.expired': 'यह अनुरोध अब सक्रिय नहीं है।',
        'helper.notOptedIn': 'आपके फैमिली अकाउंट में सहायक ड्यूटी बंद है।',
        'helper.rateLimited': 'बहुत अधिक प्रयास। थोड़ी देर बाद कोशिश करें।',
        'helper.offline': 'सर्वर तक नहीं पहुँच सके। कुछ नहीं बदला।',
        'helper.errorGeneric': 'यह काम नहीं हुआ। कुछ नहीं बदला।',
        'helper.coords': 'लोकेशन {lat}, {lng}',
        'helper.openMaps': 'मैप में खोलें',
        'helper.phone': 'फ़ोन {phone}',
        'helper.note': 'उनका संदेश',
        'helper.requester': '{name} ने अनुरोध किया',
        'helper.anonymous': 'पास का कोई परिवार',
        'helper.empty': 'इस समय आपके पास किसी को मदद की ज़रूरत नहीं है।'
      },
      te: {
        'helper.title': 'దగ్గరి సహాయకుడు',
        'helper.offTitle': 'దగ్గరి సహాయకుడిగా ఉండండి',
        'helper.offBody': 'మీ దగ్గర ఎవరైనా SOS పంపినప్పుడు తెలియజేయడానికి ఫ్యామిలీ అకౌంట్‌లో సహాయక డ్యూటీ ఆన్ చేయండి. మీరు అంగీకరించే వరకు మీ లొకేషన్ ఎప్పుడూ పంచుకోబడదు.',
        'helper.openAccount': 'ఫ్యామిలీ అకౌంట్ తెరవండి',
        'helper.settings': 'సహాయక సెట్టింగ్‌లు',
        'helper.onDuty': 'డ్యూటీలో',
        'helper.pendingPill': '{n} వేచి ఉన్నాయి',
        'helper.helpingPill': 'సహాయం జరుగుతోంది',
        'helper.idleBody': 'సహాయక డ్యూటీ ఆన్‌లో ఉంది. మీ దగ్గర SOS వస్తే తెలియజేయబడుతుంది. మీరు అంగీకరించే వరకు ఏదీ పంచుకోబడదు.',
        'helper.pendingBody': 'మీ దగ్గర ఎవరో SOS పంపారు. మీరు నిజంగా వెళ్లగలిగితే మాత్రమే అంగీకరించండి.',
        'helper.acceptedBody': 'మీరు ఈ అభ్యర్థనను అంగీకరించారు. అందుబాటులో ఉండండి; పరిస్థితి ప్రమాదకరమైతే మొదట అత్యవసర సేవలకు కాల్ చేయండి.',
        'helper.requestTitle': 'దగ్గర్లో SOS',
        'helper.acceptedTitle': 'మీరు దారిలో ఉన్నారు',
        'helper.distanceM': '{n} మీ దూరంలో',
        'helper.distanceKm': '{n} కి.మీ దూరంలో',
        'helper.justNow': 'ఇప్పుడే',
        'helper.minutesAgo': '{n} నిమిషాల క్రితం',
        'helper.hoursAgo': '{n} గంటల క్రితం',
        'helper.approxLocation': 'ఖచ్చితమైన లొకేషన్ మీరు అంగీకరించిన తర్వాతే పంచుకోబడుతుంది.',
        'helper.accept': 'నేను సహాయం చేయగలను',
        'helper.decline': 'ఇప్పుడు కాదు',
        'helper.accepted': 'అంగీకరించబడింది. ఇది మీకు మరియు అడిగిన వ్యక్తికి మాత్రమే కనిపిస్తుంది.',
        'helper.declined': 'సహాయం చేయలేమని గుర్తించబడింది.',
        'helper.loading': 'అభ్యర్థనలు చూస్తోంది…',
        'helper.refresh': 'రిఫ్రెష్',
        'helper.alreadyClaimed': 'ఈ అభ్యర్థనను మరొకరు ముందే అంగీకరించారు.',
        'helper.expired': 'ఈ అభ్యర్థన ఇప్పుడు యాక్టివ్‌లో లేదు.',
        'helper.notOptedIn': 'మీ ఫ్యామిలీ అకౌంట్‌లో సహాయక డ్యూటీ ఆఫ్‌లో ఉంది.',
        'helper.rateLimited': 'చాలా ప్రయత్నాలు జరిగాయి. కొద్దిసేపటి తర్వాత ప్రయత్నించండి.',
        'helper.offline': 'సర్వర్‌ను చేరుకోలేకపోయాం. ఏదీ మారలేదు.',
        'helper.errorGeneric': 'అది పనిచేయలేదు. ఏదీ మారలేదు.',
        'helper.coords': 'లొకేషన్ {lat}, {lng}',
        'helper.openMaps': 'మ్యాప్‌లో తెరవండి',
        'helper.phone': 'ఫోన్ {phone}',
        'helper.note': 'వారి సందేశం',
        'helper.requester': '{name} అడిగారు',
        'helper.anonymous': 'దగ్గరి కుటుంబం',
        'helper.empty': 'ఇప్పుడు మీ దగ్గర ఎవరికీ సహాయం అవసరం లేదు.'
      }
    });
  }

  /* ---------- lifecycle ---------- */

  function onView(view) {
    if (view !== 'scan') {
      stopPolling();
      return;
    }
    render();
    if (signedIn() && optedIn()) {
      presence.blocked = false;
      publishPresence();
      load({ quiet: true });
    } else {
      stopPresence();
    }
  }

  function init() {
    var root = el('helper-root');
    if (!root) return;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-live', 'polite');
    render();
    // Same rule as cloud.js: no network at boot. The duty is only polled once
    // the scan view has actually been opened.
    if (scanVisible() && signedIn() && optedIn()) load({ quiet: true });
    // Presence is not tied to the scan tab: a helper is in the pool while the
    // app is open on duty, which is what makes a 30-minute match window work.
    if (signedIn() && optedIn()) publishPresence();

    doc.addEventListener('visibilitychange', function () {
      if (doc.hidden) {
        stopPresence();
        stopPolling();
        return;
      }
      if (!signedIn() || !optedIn()) {
        stopPresence();
        return;
      }
      publishPresence();
      if (scanVisible()) load({ quiet: true });
    });
    window.addEventListener('online', function () {
      if (!signedIn() || !optedIn() || doc.hidden) return;
      publishPresence();
      if (scanVisible()) load({ quiet: true });
    });
  }

  Helper.onView = onView;
  Helper.refresh = refresh;
  Helper.render = render;
  Helper.syncPresence = syncPresence;
  Helper.state = STATE;

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
