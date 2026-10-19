'use strict';
/* Emergency lifecycle, family fan-out, and nearby-helper assignment.

 * Honesty rules enforced here:
 *  - a channel only reports "notified" when the provider accepted the message
 *  - without a configured provider, the provider is reported as not configured
 *  - coordinates are withheld from helpers until they win the accept race
 */

const config = require('./config');
const { db, audit } = require('./db');
const providers = require('./providers');
const {
  HttpError, nowIso, isoPlusSeconds, uuid, maskPhone, haversineMeters
} = require('./util');
const {
  sendJson, readBody, requireUser, limiters, limit
} = require('./http');
const { listConnections, areConnected } = require('./family');

const ACTIVE_STATES = ['sent', 'notified', 'helper_accepted'];
/* docs/API.md: the same Idempotency-Key replays for 24 h, then it is spent. */
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_HELPER = 3;
/* Read per call so an env change needs no restart of this module's logic. */
function helperLocationFreshMs() {
  return config.helperLocationFreshMs;
}

function validateLocation(location) {
  if (location == null) return null;
  if (typeof location !== 'object') throw new HttpError(400, 'invalid_body', 'location must be an object or null');
  const { lat, lng, accuracyM, ageSeconds } = location;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new HttpError(400, 'invalid_body', 'lat out of range');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new HttpError(400, 'invalid_body', 'lng out of range');
  if (accuracyM != null && (!Number.isFinite(accuracyM) || accuracyM < 0 || accuracyM > 100000)) {
    throw new HttpError(400, 'invalid_body', 'accuracyM out of range');
  }
  if (ageSeconds != null && (!Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > 86400)) {
    throw new HttpError(400, 'invalid_body', 'ageSeconds out of range');
  }
  return {
    lat: Number(lat),
    lng: Number(lng),
    accuracyM: accuracyM == null ? null : Math.round(accuracyM),
    ageSeconds: ageSeconds == null ? null : Math.round(ageSeconds)
  };
}

function serializeEmergency(row, viewerId) {
  const family = db
    .prepare(
      `SELECT u.display_name AS name, al.status
         FROM alert_logs al
         JOIN users u ON u.id = al.user_id
        WHERE al.emergency_id = ? AND al.kind = 'family'
        ORDER BY al.created_at ASC`
    )
    .all(row.id)
    .map((r) => ({ name: r.name || '', status: r.status }));

  const nearbyState = row.nearby_state || 'disabled';
  const emergency = {
    id: row.id,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    cancelledAt: row.cancelled_at,
    familyNotified: family.filter((f) => f.status === 'notified').length,
    nearby: {
      state: nearbyState,
      candidates: row.nearby_candidates || 0,
      notified: row.nearby_notified || 0
    },
    family,
    note: row.note || null,
    helperId: row.helper_id || null
  };
  if (row.helper_id) {
    const helper = db
      .prepare('SELECT id, display_name, phone FROM users WHERE id = ?')
      .get(row.helper_id);
    if (helper) {
      // Contact details are exchanged only after the helper has won the claim.
      emergency.helper = {
        userId: helper.id,
        displayName: helper.display_name || '',
        phone: helper.phone
      };
    }
  }
  if (viewerId === row.user_id || (row.helper_id && viewerId === row.helper_id)) {
    if (row.lat != null) {
      emergency.location = {
        lat: row.lat,
        lng: row.lng,
        accuracyM: row.accuracy_m,
        ageSeconds: row.location_age_seconds
      };
    }
  }
  return emergency;
}

function serializeAssignment(row, precise) {
  const emergency = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(row.emergency_id);
  const requester = db.prepare('SELECT * FROM users WHERE id = ?').get(emergency.user_id);
  const request = {
    displayName: requester.display_name || '',
    distanceM: row.distance_m,
    accuracyM: emergency.accuracy_m,
    ageSeconds: emergency.location_age_seconds,
    note: emergency.note || null,
    precise: !!precise
  };
  if (precise) {
    request.lat = emergency.lat;
    request.lng = emergency.lng;
  }
  return {
    id: row.id,
    emergencyId: row.emergency_id,
    status: row.status,
    createdAt: row.created_at,
    state: row.emergency_state || emergency.state,
    request
  };
}

function eligibleHelpers(user, location) {
  if (!location) return [];
  const cutoff = new Date(Date.now() - helperLocationFreshMs()).toISOString();
  // Contract exclusions: opted-out helpers, the requester, blocked pairs (either
  // direction), stale locations, and helpers already at their pending cap.
  const helpers = db
    .prepare(
      `SELECT u.*, h.lat AS h_lat, h.lng AS h_lng, h.accuracy_m AS h_accuracy, h.updated_at AS h_updated
         FROM users u JOIN helper_locations h ON h.user_id = u.id
        WHERE u.helper_opt_in = 1 AND u.id <> ? AND h.updated_at >= ?
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.user_id = ? AND b.blocked_user_id = u.id)
                OR (b.user_id = u.id AND b.blocked_user_id = ?)
          )`
    )
    .all(user.id, cutoff, user.id, user.id);
  const radius = config.nearbyRadiusM;
  const maxHelpers = config.nearbyMaxHelpers;
  const pendingStmt = db.prepare(
    `SELECT COUNT(*) AS n
       FROM helper_assignments a JOIN emergencies e ON e.id = a.emergency_id
      WHERE a.helper_id = ? AND a.status = 'pending'
        AND e.expires_at > ? AND e.state IN ('sent','notified','helper_accepted')`
  );
  const out = [];
  for (const h of helpers) {
    const distance = Math.round(haversineMeters(location.lat, location.lng, h.h_lat, h.h_lng));
    if (distance > radius) continue;
    // Only live, unanswered requests count toward the cap.
    if (pendingStmt.get(h.id, nowIso()).n >= MAX_PENDING_PER_HELPER) continue;
    out.push({ user: h, distance });
  }
  // FS_NEARBY_MAX_HELPERS bounds the fan-out; nearest helpers win.
  return out.sort((a, b) => a.distance - b.distance).slice(0, maxHelpers);
}

function configuredChannels() {
  return { push: providers.pushConfigured(), webhook: providers.webhookConfigured() };
}

async function createEmergency(req, res) {
  const user = requireUser(req);
  const body = await readBody(req);
  const location = validateLocation(body.location);
  const note = body.note == null ? null : String(body.note).trim();
  if (note != null && (note.length < 1 || note.length > 200)) {
    throw new HttpError(400, 'invalid_body', 'note must be 1..200 characters');
  }
  const key = req.headers['idempotency-key'];
  let idempotencyKey = typeof key === 'string' ? key.trim().slice(0, 200) : null;
  if (idempotencyKey === '') idempotencyKey = null;

  if (idempotencyKey) {
    const existing = db
      .prepare('SELECT * FROM emergencies WHERE user_id = ? AND idempotency_key = ?')
      .get(user.id, idempotencyKey);
    if (existing) {
      const ageMs = Date.now() - Date.parse(existing.created_at);
      if (!Number.isFinite(ageMs) || ageMs <= IDEMPOTENCY_WINDOW_MS) {
        // Replay: same key inside the window returns the same emergency row.
        return sendJson(res, 201, { emergency: serializeEmergency(existing, user.id) });
      }
      // Key is spent. Release it from the old row so the partial unique index
      // on (user_id, idempotency_key) can accept the new emergency.
      db.prepare('UPDATE emergencies SET idempotency_key = NULL WHERE id = ?').run(existing.id);
    }
  }

  // Only people who asked to alert family, or who opted in to help, can raise an
  // emergency. The check is here so both client paths stay honest.
  if (!user.alerts_family && !user.helper_opt_in) {
    // Frozen vocabulary: 403 not_opted_in — the caller has not consented to
    // either alerting family or acting as a helper.
    throw new HttpError(403, 'not_opted_in', 'Enable family alerts before raising an emergency');
  }

  limit(limiters.emergency, 'emergency', user.id, config.emergencyRateLimit, config.emergencyRateWindowSeconds);

  const active = db
    .prepare(
      `SELECT * FROM emergencies
        WHERE user_id = ? AND state IN ('sent','notified','helper_accepted')
          AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(user.id, nowIso());
  if (active) {
    throw new HttpError(409, 'state_conflict', 'An emergency is already active', {
      emergency: serializeEmergency(active, user.id)
    });
  }

  const id = uuid();
  const createdAt = nowIso();
  const expiresAt = isoPlusSeconds(config.emergencyTtlSeconds);
  db.prepare(
    `INSERT INTO emergencies
       (id, user_id, state, lat, lng, accuracy_m, location_age_seconds, note, created_at, expires_at, idempotency_key, nearby_state)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    user.id,
    'sent',
    location ? location.lat : null,
    location ? location.lng : null,
    location ? location.accuracyM : null,
    location ? location.ageSeconds : null,
    note || null,
    createdAt,
    expiresAt,
    idempotencyKey,
    location ? 'disabled' : 'no_location'
  );

  // Family fan-out: the operator webhook is preferred; otherwise each member's
  // registered devices get a push. Alert rows record exactly what happened.
  const members = listConnections(user.id);
  const channels = configuredChannels();
  const memberStatuses = new Map();
  if (members.length && channels.webhook) {
    const result = await providers.notifyFamilyWebhook({
      emergencyId: id,
      requester: { displayName: user.display_name || '', phone: user.phone },
      members
    });
    const status = result.status === 'notified' ? 'notified' : 'failed';
    for (const member of members) memberStatuses.set(member.id, status);
  } else if (members.length && channels.push) {
    for (const member of members) {
      const push = await providers.pushToUser(
        member.id,
        { type: 'family_emergency', emergencyId: id },
        id
      );
      // Contract: per-member status is exactly "notified" | "no_channel".
      memberStatuses.set(member.id, push.status === 'sent' ? 'notified' : 'no_channel');
    }
  } else {
    for (const member of members) memberStatuses.set(member.id, 'no_channel');
  }
  let familyNotified = 0;
  for (const member of members) {
    const status = memberStatuses.get(member.id) || 'no_channel';
    if (status === 'notified') familyNotified += 1;
    db.prepare(
      'INSERT INTO alert_logs (id, emergency_id, user_id, kind, status, created_at) VALUES (?,?,?,?,?,?)'
    ).run(uuid(), id, member.id, 'family', status, nowIso());
  }

  let nearbyState;
  let candidates = [];
  let notified = 0;
  if (!location) {
    nearbyState = 'no_location';
  } else {
    candidates = eligibleHelpers(user, location);
    if (candidates.length === 0) {
      nearbyState = 'no_helpers';
    } else {
      // Pending rows are created even when no push transport is configured: an
      // open helper app polls GET /v1/helper/assignments, so the request is still
      // reachable in the foreground. Without push it is never called "notified".
      for (const c of candidates) {
        const assignmentId = uuid();
        db.prepare(
          `INSERT INTO helper_assignments (id, emergency_id, helper_id, status, distance_m, created_at)
           VALUES (?,?,?,?,?,?)`
        ).run(assignmentId, id, c.user.id, 'pending', c.distance, nowIso());
        if (!channels.push) continue;
        const push = await providers.pushToUser(
          c.user.id,
          { type: 'helper_request', assignmentId, emergencyId: id, distanceM: c.distance },
          id
        );
        if (push.status === 'sent') notified += 1;
      }
      // Honest states only: "notified" requires at least one handed-off push.
      nearbyState = channels.push ? 'notified' : 'not_configured';
    }
  }
  db.prepare('UPDATE emergencies SET nearby_state = ?, nearby_candidates = ?, nearby_notified = ? WHERE id = ?')
    .run(nearbyState, candidates.length, notified, id);

  audit(user.id, 'emergency.created', id, { nearbyState, familyNotified });
  const row = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(id);
  sendJson(res, 201, { emergency: serializeEmergency(row, user.id) });
}

function loadEmergencyForViewer(user, id) {
  const row = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'not_found', 'Emergency not found');
  const isHelper = db
    .prepare("SELECT 1 FROM helper_assignments WHERE emergency_id = ? AND helper_id = ? AND status = 'accepted'")
    .get(id, user.id);
  if (row.user_id !== user.id && !isHelper) {
    throw new HttpError(403, 'forbidden', 'You do not have access to this emergency');
  }
  return row;
}

async function getEmergency(req, res, id) {
  const user = requireUser(req);
  const row = loadEmergencyForViewer(user, id);
  sendJson(res, 200, { emergency: serializeEmergency(row, user.id) });
}

async function cancelEmergency(req, res, id) {
  const user = requireUser(req);
  const row = loadEmergencyForViewer(user, id);
  if (row.user_id !== user.id) throw new HttpError(403, 'forbidden', 'Only the requester can cancel');
  if (row.state === 'cancelled') return sendJson(res, 200, { emergency: serializeEmergency(row, user.id) });
  if (!ACTIVE_STATES.includes(row.state)) {
    throw new HttpError(409, 'state_conflict', 'That emergency can no longer be cancelled');
  }

  const cancelledAt = nowIso();
  const tx = db.transaction(() => {
    db.prepare("UPDATE emergencies SET state = 'cancelled', cancelled_at = ? WHERE id = ?").run(cancelledAt, id);
    db.prepare("UPDATE helper_assignments SET status = 'cancelled', responded_at = ? WHERE emergency_id = ? AND status = 'pending'")
      .run(cancelledAt, id);
  });
  tx();
  audit(user.id, 'emergency.cancelled', id, null);
  const updated = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(id);
  sendJson(res, 200, { emergency: serializeEmergency(updated, user.id) });
}

function loadAssignment(id) {
  return db.prepare('SELECT * FROM helper_assignments WHERE id = ?').get(id);
}

async function listAssignments(req, res) {
  const user = requireUser(req);
  const rows = db
    .prepare(
      `SELECT a.*, e.state AS emergency_state, e.expires_at
         FROM helper_assignments a JOIN emergencies e ON e.id = a.emergency_id
        WHERE a.helper_id = ?
          AND a.status IN ('pending','accepted')
          AND e.expires_at > ?
        ORDER BY a.created_at DESC`
    )
    .all(user.id, nowIso());
  const assignments = rows.map((row) => serializeAssignment(row, row.status === 'accepted'));
  sendJson(res, 200, { assignments });
}

async function acceptAssignment(req, res, id) {
  const user = requireUser(req);
  const row = loadAssignment(id);
  if (!row || row.helper_id !== user.id) throw new HttpError(404, 'not_found', 'Assignment not found');

  let claimed = false;
  db.transaction(() => {
    const emergency = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(row.emergency_id);
    if (!emergency || !ACTIVE_STATES.includes(emergency.state)) {
      throw new HttpError(409, 'state_conflict', 'That request is no longer active');
    }
    if (emergency.expires_at <= nowIso()) {
      throw new HttpError(409, 'state_conflict', 'That request expired');
    }
    if (emergency.helper_id) throw new HttpError(409, 'already_claimed', 'Another helper already accepted');
    const updated = db
      .prepare("UPDATE helper_assignments SET status = 'accepted', responded_at = ? WHERE id = ? AND status = 'pending'")
      .run(nowIso(), id);
    if (updated.changes !== 1) throw new HttpError(409, 'already_claimed', 'Another helper already accepted');
    db.prepare("UPDATE emergencies SET state = 'helper_accepted', helper_id = ? WHERE id = ?")
      .run(user.id, emergency.id);
    db.prepare("UPDATE helper_assignments SET status = 'expired' WHERE emergency_id = ? AND id <> ? AND status = 'pending'")
      .run(emergency.id, id);
    claimed = true;
  })();

  if (!claimed) throw new HttpError(409, 'already_claimed', 'Another helper already accepted');
  audit(user.id, 'helper.accepted', row.emergency_id, null);
  const updated = loadAssignment(id);
  const emergency = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(row.emergency_id);
  const requester = db.prepare('SELECT * FROM users WHERE id = ?').get(emergency.user_id);
  sendJson(res, 200, {
    assignment: serializeAssignment(updated, true),
    requester: {
      userId: requester.id,
      displayName: requester.display_name || '',
      phone: requester.phone,
      lat: emergency.lat,
      lng: emergency.lng,
      accuracyM: emergency.accuracy_m,
      note: emergency.note || null,
      emergencyId: emergency.id
    }
  });
}

async function declineAssignment(req, res, id) {
  const user = requireUser(req);
  const row = loadAssignment(id);
  if (!row || row.helper_id !== user.id) throw new HttpError(404, 'not_found', 'Assignment not found');
  if (row.status !== 'pending') throw new HttpError(409, 'state_conflict', 'That request was already answered');
  db.prepare("UPDATE helper_assignments SET status = 'declined', responded_at = ? WHERE id = ? AND status = 'pending'")
    .run(nowIso(), id);
  audit(user.id, 'helper.declined', row.emergency_id, null);
  sendJson(res, 200, { assignment: serializeAssignment(loadAssignment(id), false) });
}

async function submitReport(req, res) {
  const user = requireUser(req);
  const body = await readBody(req);
  const reasons = ['spam', 'abuse', 'other'];
  if (!reasons.includes(body.reason)) {
    throw new HttpError(400, 'invalid_body', 'reason must be spam, abuse or other');
  }
  limit(limiters.reports, 'report', user.id, config.reportRateLimit, 3600);
  let targetId = null;
  if (body.assignmentId != null) {
    const assignment = db.prepare('SELECT * FROM helper_assignments WHERE id = ?').get(String(body.assignmentId));
    if (!assignment) throw new HttpError(404, 'not_found', 'Assignment not found');
    const emergency = db.prepare('SELECT * FROM emergencies WHERE id = ?').get(assignment.emergency_id);
    if (assignment.helper_id !== user.id && emergency.user_id !== user.id) {
      throw new HttpError(403, 'forbidden', 'You can only report your own interactions');
    }
    targetId = assignment.helper_id === user.id ? emergency.user_id : assignment.helper_id;
  }
  db.prepare('INSERT INTO reports (id, reporter_id, target_user_id, assignment_id, reason, created_at) VALUES (?,?,?,?,?,?)')
    .run(uuid(), user.id, targetId, body.assignmentId ? String(body.assignmentId) : null, body.reason, nowIso());
  audit(user.id, 'report.created', targetId, { reason: body.reason });
  sendJson(res, 202, { accepted: true });
}

async function publishHelperLocation(req, res) {
  const user = requireUser(req);
  if (!user.helper_opt_in) {
    throw new HttpError(403, 'not_opted_in', 'Enable nearby helper first');
  }
  const body = await readBody(req);
  const location = validateLocation(body.location || body);
  if (!location) throw new HttpError(400, 'invalid_body', 'location is required');
  db.prepare(
    `INSERT INTO helper_locations (user_id, lat, lng, accuracy_m, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng,
       accuracy_m = excluded.accuracy_m, updated_at = excluded.updated_at`
  ).run(user.id, location.lat, location.lng, location.accuracyM, nowIso());
  sendJson(res, 200, { published: true });
}

module.exports = {
  createEmergency,
  getEmergency,
  cancelEmergency,
  listAssignments,
  acceptAssignment,
  declineAssignment,
  submitReport,
  publishHelperLocation,
  serializeEmergency
};
