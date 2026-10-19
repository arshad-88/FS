'use strict';
/* HTTP plumbing shared by every route module: JSON responses, CORS, auth, rate limits. */

const crypto = require('node:crypto');
const config = require('./config');
const { db } = require('./db');
const { HttpError, sha256, nowIso } = require('./util');

const JSON_LIMIT = 64 * 1024;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, payload) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

/** Reads and validates a JSON object body, with a hard byte cap. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > JSON_LIMIT) {
        reject(new HttpError(400, 'invalid_body', 'Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (err) {
        return reject(new HttpError(400, 'invalid_body', 'Body must be valid JSON'));
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(new HttpError(400, 'invalid_body', 'Body must be a JSON object'));
      }
      resolve(parsed);
    });
    req.on('error', reject);
  });
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

/**
 * Resolves the caller from the bearer token. Sessions are stored hashed so a
 * database leak does not hand out live tokens.
 */
function currentUser(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.token_hash, s.expires_at, s.revoked_at, u.*
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    )
    .get(sha256(token));
  if (!row || row.revoked_at) return null;
  if (row.expires_at <= nowIso()) return null;
  return row;
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'unauthorized', 'Missing or expired session');
  return user;
}

function publicUser(user) {
  return {
    id: user.id,
    phone: user.phone,
    displayName: user.display_name || '',
    prefs: {
      alertsFamily: !!user.alerts_family,
      shareLocationOnEmergency: !!user.share_location,
      nearbyHelperOptIn: !!user.helper_opt_in
    }
  };
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + config.sessionTtlDays * 86400000).toISOString();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)'
  ).run(sha256(token), userId, nowIso(), expires);
  return { token, expiresAt: expires };
}

/** Sliding-window limiter instances, one bucket per protection domain. */
const limiters = {
  otpPhone: new (require('./util').RateLimiter)(),
  otpIp: new (require('./util').RateLimiter)(),
  otpVerify: new (require('./util').RateLimiter)(),
  emergency: new (require('./util').RateLimiter)(),
  familyInvite: new (require('./util').RateLimiter)(),
  accept: new (require('./util').RateLimiter)(),
  reports: new (require('./util').RateLimiter)()
};

/**
 * Applies a limiter and throws the contract 429 shape.
 * keyDomain keeps independent counters from colliding.
 */
function limit(limiter, keyDomain, key, max, windowSeconds) {
  const result = limiter.check(keyDomain + ':' + key, max, windowSeconds * 1000);
  if (!result.ok) {
    throw new HttpError(429, 'rate_limited', 'Too many requests', {
      retryAfterSeconds: result.retryAfterSeconds
    });
  }
}

/** Rough client IP, IPv4-mapped IPv6 normalised. */
function clientIp(req) {
  const raw = (req.socket && req.socket.remoteAddress) || 'unknown';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

module.exports = {
  setCors,
  sendJson,
  sendNoContent,
  readBody,
  bearerToken,
  currentUser,
  requireUser,
  publicUser,
  createSession,
  limiters,
  limit,
  clientIp
};
