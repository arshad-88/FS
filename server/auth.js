'use strict';
/* OTP authentication and session lifecycle. Nothing is faked: unconfigured SMS is reported. */

const crypto = require('node:crypto');
const config = require('./config');
const { db, audit } = require('./db');
const providers = require('./providers');
const {
  HttpError, normalizePhone, nowIso, isoPlusSeconds, uuid, sha256, constantTimeEqual, log
} = require('./util');
const {
  sendJson, sendNoContent, readBody, requireUser, publicUser, createSession,
  limiters, limit, clientIp, bearerToken
} = require('./http');

function codeHash(challengeId, code) {
  return crypto.createHmac('sha256', config.tokenSecret).update(challengeId + ':' + code).digest('hex');
}

function linkInvitations(userId, phone) {
  db.prepare(
    "UPDATE family_requests SET to_user_id = ? WHERE to_phone = ? AND to_user_id IS NULL AND status = 'pending'"
  ).run(userId, phone);
}

function findOrCreateUser(phone) {
  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (user) return user;
  const id = uuid();
  db.prepare('INSERT INTO users (id, phone, display_name, created_at) VALUES (?,?,?,?)')
    .run(id, phone, '', nowIso());
  linkInvitations(id, phone);
  audit(id, 'user.created', id, null);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

async function requestOtp(req, res) {
  const body = await readBody(req);
  const phone = normalizePhone(body.phone);
  if (!phone) throw new HttpError(400, 'invalid_phone', 'Use E.164 format, e.g. +919876543210');

  limit(limiters.otpPhone, 'otp-phone', phone, config.otpRequestLimitPerPhone, config.otpRequestWindowSeconds);
  limit(limiters.otpIp, 'otp-ip', clientIp(req), config.otpRequestLimitPerIp, config.otpRequestWindowSeconds);

  const challengeId = uuid();
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare(
    `INSERT INTO otp_challenges (id, phone, code_hash, attempts, created_at, expires_at)
     VALUES (?,?,?,0,?,?)`
  ).run(challengeId, phone, codeHash(challengeId, code), nowIso(), isoPlusSeconds(config.otpTtlSeconds));

  if (config.devMode) {
    log('[otp]', phone, 'code', code, '(dev mode only — never enabled in production)');
  }

  const delivery = await providers.sendSmsOtp(phone, code);
  const payload = {
    challengeId,
    expiresInSeconds: config.otpTtlSeconds,
    delivery: { channel: 'sms', status: delivery.status }
  };
  if (delivery.status === 'provider_not_configured' && !config.devMode) {
    return sendJson(res, 503, {
      error: 'provider_not_configured',
      message: 'SMS delivery is not configured on this server',
      ...payload
    });
  }
  if (delivery.status === 'provider_not_configured' && config.devMode) {
    payload.delivery.status = 'dev_console';
  }
  sendJson(res, 202, payload);
}

async function verifyOtp(req, res) {
  const body = await readBody(req);
  const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!challengeId || !/^\d{6}$/.test(code)) {
    throw new HttpError(400, 'invalid_code', 'Enter the 6-digit code');
  }
  limit(limiters.otpVerify, 'otp-verify', clientIp(req) + ':' + challengeId, 20, config.otpRequestWindowSeconds);

  const challenge = db.prepare('SELECT * FROM otp_challenges WHERE id = ?').get(challengeId);
  if (!challenge || challenge.consumed_at) {
    throw new HttpError(400, 'invalid_code', 'That code is not valid');
  }
  if (challenge.expires_at <= nowIso()) {
    throw new HttpError(400, 'invalid_code', 'That code has expired');
  }
  if (challenge.attempts >= config.otpMaxAttempts) {
    throw new HttpError(429, 'rate_limited', 'Too many attempts for this code', { retryAfterSeconds: 300 });
  }

  db.prepare('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?').run(challengeId);
  if (!constantTimeEqual(challenge.code_hash, codeHash(challengeId, code))) {
    throw new HttpError(400, 'invalid_code', 'That code is not valid');
  }

  db.prepare('UPDATE otp_challenges SET consumed_at = ? WHERE id = ?').run(nowIso(), challengeId);
  const user = findOrCreateUser(challenge.phone);
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(nowIso(), user.id);
  const session = createSession(user.id);
  audit(user.id, 'auth.login', user.id, { channel: 'otp' });
  sendJson(res, 200, { token: session.token, user: publicUser(user) });
}

async function logout(req, res) {
  const token = bearerToken(req);
  const user = requireUser(req);
  if (token) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(nowIso(), sha256(token));
  }
  audit(user.id, 'auth.logout', user.id, null);
  sendNoContent(res);
}

module.exports = { requestOtp, verifyOtp, logout };
