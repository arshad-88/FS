'use strict';
/* Family connections: invitations require consent from both sides. */

const config = require('./config');
const { db, audit } = require('./db');
const {
  HttpError, normalizePhone, nowIso, uuid, maskPhone
} = require('./util');
const {
  sendJson, sendNoContent, readBody, requireUser, limiters, limit
} = require('./http');
const providers = require('./providers');

const PENDING = 'pending';
const ACTIVE_CONNECTION = "c.removed_at IS NULL";

/**
 * Connection shape frozen in docs/API.md:
 * { id, userId, name, phoneMasked, since, alertsFamily }
 * `id` is the connection id (what DELETE /v1/family/connections/:id takes).
 */
function connectionView(row) {
  return {
    id: row.connection_id || row.id,
    userId: row.id,
    name: row.display_name || '',
    phoneMasked: maskPhone(row.phone),
    since: row.connected_at,
    alertsFamily: !!row.alerts_family
  };
}

function connectionRow(a, b) {
  return db
    .prepare(
      `SELECT * FROM connections
        WHERE removed_at IS NULL
          AND ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?))`
    )
    .get(a, b, b, a);
}

function areConnected(a, b) {
  return !!connectionRow(a, b);
}

function listConnections(userId) {
  return db
    .prepare(
      `SELECT u.*, c.id AS connection_id, c.created_at AS connected_at
         FROM connections c
         JOIN users u ON u.id = CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END
        WHERE c.removed_at IS NULL AND (c.user_a = ? OR c.user_b = ?)
        ORDER BY c.created_at ASC`
    )
    .all(userId, userId, userId);
}

/** Finds one live connection of `userId` by connection id or by peer user id. */
function findConnection(userId, ref) {
  const key = typeof ref === 'string' ? ref.trim() : '';
  if (!key) return null;
  return (
    db
      .prepare(
        "SELECT * FROM connections WHERE removed_at IS NULL AND id = ? AND (user_a = ? OR user_b = ?)"
      )
      .get(key, userId, userId) ||
    db
      .prepare(
        `SELECT * FROM connections
          WHERE removed_at IS NULL
            AND ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?))`
      )
      .get(userId, key, key, userId) ||
    null
  );
}

function blockedEitherWay(a, b) {
  return !!db
    .prepare(
      `SELECT 1 FROM blocks
        WHERE (user_id = ? AND blocked_user_id = ?)
           OR (user_id = ? AND blocked_user_id = ?)`
    )
    .get(a, b, b, a);
}

function serializeRequest(row, caller) {
  const outgoing = row.from_user_id === caller.id;
  const sender = db
    .prepare('SELECT id, display_name, phone FROM users WHERE id = ?')
    .get(row.from_user_id);
  const target = row.to_user_id
    ? db.prepare('SELECT id, display_name, phone FROM users WHERE id = ?').get(row.to_user_id)
    : null;

  const from = outgoing
    ? { name: caller.display_name || '', phoneMasked: maskPhone(caller.phone) }
    : { name: sender ? sender.display_name || '' : '', phoneMasked: maskPhone(sender ? sender.phone : row.to_phone) };

  // Enumeration protection: the recipient is only ever a masked number until
  // the request has actually been accepted.
  const to = { phoneMasked: maskPhone(outgoing ? (target ? target.phone : row.to_phone) : caller.phone) };
  if (row.status === 'accepted' && target) to.toName = target.display_name || '';

  return {
    id: row.id,
    direction: outgoing ? 'outgoing' : 'incoming',
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    from,
    to
  };
}

async function listFamily(req, res) {
  const user = requireUser(req);
  const connections = listConnections(user.id).map(connectionView);
  const incoming = db
    .prepare("SELECT * FROM family_requests WHERE to_user_id = ? AND status = 'pending' ORDER BY created_at DESC")
    .all(user.id)
    .map((row) => serializeRequest(row, user));
  const outgoing = db
    .prepare("SELECT * FROM family_requests WHERE from_user_id = ? AND status = 'pending' ORDER BY created_at DESC")
    .all(user.id)
    .map((row) => serializeRequest(row, user));
  sendJson(res, 200, { incoming, outgoing, connections });
}

async function createRequest(req, res) {
  const user = requireUser(req);
  const body = await readBody(req);
  const phone = normalizePhone(body.phone);
  if (!phone) throw new HttpError(400, 'invalid_phone', 'Use E.164 format, e.g. +919876543210');
  if (phone === user.phone) throw new HttpError(400, 'invalid_phone', 'You cannot add your own number');

  limit(limiters.familyInvite, 'family-invite', user.id, config.familyInviteRateLimit, 3600);

  const target = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (target && blockedEitherWay(user.id, target.id)) {
    throw new HttpError(403, 'forbidden', 'This person cannot be added');
  }
  if (target && areConnected(user.id, target.id)) {
    throw new HttpError(409, 'already_connected', 'That person is already in your family');
  }
  const pendingOut = db
    .prepare("SELECT * FROM family_requests WHERE from_user_id = ? AND to_phone = ? AND status = 'pending'")
    .get(user.id, phone);
  if (pendingOut) throw new HttpError(409, 'already_requested', 'A request is already pending');
  if (target) {
    const pendingIn = db
      .prepare("SELECT * FROM family_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'")
      .get(target.id, user.id);
    if (pendingIn) throw new HttpError(409, 'already_requested', 'This person already invited you — accept it instead');
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO family_requests (id, from_user_id, to_user_id, to_phone, kind, status, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(id, user.id, target ? target.id : null, phone, target ? 'request' : 'invitation', PENDING, nowIso());
  audit(user.id, 'family.requested', target ? target.id : null, { kind: target ? 'request' : 'invitation' });

  // The invitation is delivered in-app on the recipient's next sync. Push is
  // best-effort and its real transport status is reported, never assumed.
  if (target) {
    await providers.pushToUser(target.id, { type: 'family_request', requestId: id }, null);
  }

  const row = db.prepare('SELECT * FROM family_requests WHERE id = ?').get(id);
  sendJson(res, 200, { request: serializeRequest(row, user) });
}

/**
 * accept / reject. Both answer with `{ request }` (status already moved to
 * `accepted` / `rejected`) so the client never has to guess the new state.
 */
function respondRequest(req, res, id) {
  return (async () => {
    const user = requireUser(req);
    const body = await readBody(req);
    const row = db.prepare('SELECT * FROM family_requests WHERE id = ?').get(id);
    if (!row || row.to_user_id !== user.id) {
      throw new HttpError(404, 'not_found', 'Request not found');
    }
    if (row.status !== PENDING) {
      throw new HttpError(409, 'state_conflict', 'That request was already answered');
    }

    if (body.action === 'reject') {
      db.prepare("UPDATE family_requests SET status = 'rejected', responded_at = ? WHERE id = ?")
        .run(nowIso(), id);
      audit(user.id, 'family.rejected', row.from_user_id, null);
      const rejected = Object.assign({}, row, { status: 'rejected' });
      return sendJson(res, 200, { request: serializeRequest(rejected, user) });
    }
    if (body.action !== 'accept') {
      throw new HttpError(400, 'invalid_body', "action must be 'accept' or 'reject'");
    }
    if (blockedEitherWay(user.id, row.from_user_id)) {
      throw new HttpError(403, 'forbidden', 'This connection is not allowed');
    }

    // Idempotent: if the connection already exists the request is simply
    // marked accepted; the contract keeps 409 already_connected for the
    // concurrent-accept race, which the UNIQUE constraint below also covers.
    if (!areConnected(user.id, row.from_user_id)) {
      const pair = [user.id, row.from_user_id].sort();
      db.prepare('INSERT INTO connections (id, user_a, user_b, created_at) VALUES (?,?,?,?)')
        .run(uuid(), pair[0], pair[1], nowIso());
    }
    db.prepare("UPDATE family_requests SET status = 'accepted', responded_at = ? WHERE id = ?")
      .run(nowIso(), id);
    audit(user.id, 'family.accepted', row.from_user_id, null);

    const accepted = Object.assign({}, row, { status: 'accepted' });
    sendJson(res, 200, { request: serializeRequest(accepted, user) });
  })();
}

async function removeConnection(req, res, ref) {
  const user = requireUser(req);
  const row = findConnection(user.id, ref);
  if (!row) throw new HttpError(404, 'not_found', 'Connection not found');
  db.prepare('UPDATE connections SET removed_at = ? WHERE id = ? AND removed_at IS NULL')
    .run(nowIso(), row.id);
  const otherId = row.user_a === user.id ? row.user_b : row.user_a;
  audit(user.id, 'family.removed', otherId, null);
  sendNoContent(res);
}

module.exports = {
  listFamily,
  createRequest,
  respondRequest,
  removeConnection,
  listConnections,
  connectionView,
  areConnected,
  blockedEitherWay
};
