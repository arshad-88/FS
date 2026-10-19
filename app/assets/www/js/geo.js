/* FamilyShield — geolocation bridge polyfill.
 *
 * The WebView ships with `navigator.geolocation` disabled: MainActivity requests the
 * ACCESS_FINE_LOCATION runtime permission itself and reads one fix through
 * LocationManager, then answers `window.FS.nativeLocation(json)`. This file adapts
 * that native channel back into the standard `navigator.geolocation` API so every
 * module (SOS, helpers, family location) can use ordinary web code and never has to
 * know whether it is running inside the Android shell or a desktop browser.
 *
 * Bridge contract (app/java/com/familyshield/app/MainActivity.java):
 *   FSAndroid.requestLocation(id, fine)  -> async window.FS.nativeLocation(payload)
 *   FSAndroid.cancelLocation(id)
 *   payload = {id, lat, lon, accuracy, ts}  on success
 *           = {id, error: "denied"|"unavailable"|"cancelled"|"timeout"} on failure
 *
 * When the bridge is absent (desktop preview, plain browser) nothing is patched and
 * the platform implementation is left exactly as it is.
 */
(function () {
  'use strict';

  var FS = (window.FS = window.FS || {});
  if (FS.geo) return;

  var bridge = window.FSAndroid;
  var bridged = !!(bridge && typeof bridge.requestLocation === 'function');

  var nextId = 0;
  var pending = {};          // id -> {success, error, timer}
  var watchSeq = 0;
  var watches = {};          // watchId -> {timer, last, options}

  var DEFAULT_TIMEOUT = 30000;

  function makeError(kind) {
    switch (kind) {
      case 'denied':
        return { code: 1, message: 'Location permission was denied.' };
      case 'cancelled':
        return { code: 3, message: 'Location request was cancelled.' };
      case 'timeout':
        return { code: 3, message: 'Timed out waiting for a location fix.' };
      default:
        return { code: 2, message: 'Location is unavailable on this device.' };
    }
  }

  function settle(id, payload, ok) {
    var entry = pending[id];
    if (!entry) return;
    delete pending[id];
    if (entry.timer) clearTimeout(entry.timer);
    var fn = ok ? entry.success : entry.error;
    if (typeof fn !== 'function') return;
    try {
      if (ok) {
        fn({
          coords: {
            latitude: payload.lat,
            longitude: payload.lon,
            accuracy: typeof payload.accuracy === 'number' ? payload.accuracy : null,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null
          },
          timestamp: typeof payload.ts === 'number' ? payload.ts : Date.now()
        });
      } else {
        fn(makeError(payload.error));
      }
    } catch (err) {
      /* a throwing consumer must not break the bridge callback */
    }
  }

  /** Entry point used by MainActivity.evaluateJavascript. */
  function nativeLocation(payload) {
    if (!payload || payload.id == null) return;
    var id = String(payload.id);
    if (payload.error) settle(id, { error: String(payload.error) }, false);
    else settle(id, payload, true);
  }

  if (bridged) {
    // Chain rather than replace: another module may already listen here.
    var previous = FS.nativeLocation;
    FS.nativeLocation = function (payload) {
      nativeLocation(payload);
      if (typeof previous === 'function') {
        try { previous(payload); } catch (err) { /* ignore */ }
      }
    };
  }

  function request(success, error, options) {
    options = options || {};
    var id = 'loc' + (++nextId);
    pending[id] = {
      success: success,
      error: error,
      timer: setTimeout(function () {
        if (!pending[id]) return;
        try { bridge.cancelLocation(id); } catch (err) { /* ignore */ }
        settle(id, { error: 'timeout' }, false);
      }, options.timeout > 0 ? options.timeout : DEFAULT_TIMEOUT)
    };
    try {
      bridge.requestLocation(id, options.enableHighAccuracy !== false);
    } catch (err) {
      settle(id, { error: 'unavailable' }, false);
    }
  }

  function cancel(id) {
    try { bridge.cancelLocation(id); } catch (err) { /* ignore */ }
    if (pending[id] && pending[id].timer) clearTimeout(pending[id].timer);
    delete pending[id];
  }

  /** Promise wrapper for new code: resolves {lat, lon, accuracy} or rejects an Error. */
  function getLocation(options) {
    return new Promise(function (resolve, reject) {
      if (!bridged) {
        if (navigator.geolocation && navigator.geolocation.getCurrentPosition) {
          navigator.geolocation.getCurrentPosition(
            function (pos) {
              resolve({
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                accuracy: pos.coords.accuracy
              });
            },
            function (err) { reject(err); },
            options
          );
          return;
        }
        reject(new Error('Location is not available in this build.'));
        return;
      }
      request(
        function (pos) {
          resolve({
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: pos.coords.accuracy
          });
        },
        function (err) { reject(err); },
        options
      );
    });
  }

  if (bridged) {
    var geo = {
      getCurrentPosition: function (success, error, options) {
        request(success, error, options);
      },
      watchPosition: function (success, error, options) {
        var watchId = ++watchSeq;
        options = options || {};
        var intervalMs = options.maximumAge > 0 ? options.maximumAge : 15000;
        var tick = function () {
          if (!watches[watchId]) return;
          request(
            function (pos) {
              if (!watches[watchId]) return;
              watches[watchId].last = pos;
              if (typeof success === 'function') {
                try { success(pos); } catch (err) { /* ignore */ }
              }
            },
            function (err) {
              if (!watches[watchId]) return;
              if (typeof error === 'function') {
                try { error(err); } catch (e) { /* ignore */ }
              }
            },
            options
          );
        };
        watches[watchId] = {
          last: null,
          options: options,
          timer: setInterval(tick, intervalMs)
        };
        tick();
        return watchId;
      },
      clearWatch: function (watchId) {
        var watch = watches[watchId];
        if (!watch) return;
        clearInterval(watch.timer);
        delete watches[watchId];
      }
    };

    try {
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        enumerable: true,
        value: geo
      });
    } catch (err) {
      try { navigator.geolocation = geo; } catch (e2) { /* nothing else to try */ }
    }
  }

  FS.geo = {
    /** True when fixes come from the Android bridge (permission handled natively). */
    bridged: bridged,
    getLocation: getLocation,
    /** Human-readable reason for a failed fix, safe to show in the UI. */
    describe: function (err) {
      if (!err) return 'Location is unavailable.';
      if (typeof err === 'string') return err;
      return err.message || 'Location is unavailable.';
    }
  };
})();
