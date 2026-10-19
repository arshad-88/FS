'use strict';
/* Small shared helpers: HTTP errors, body parsing, phone handling, rate limiting, geo. */

const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

const MAX_BODY_BYTES = 64 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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

/**
 * Normalises a user-supplied phone number to E.164 without a per-country guess:
 * the user must type the country code. Returns null when it cannot be trusted.
 */
function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  let raw = input.trim().replace(/[\s()\-.]/g, '');
  if (raw.startsWith('00')) raw = '+' + raw.slice(2);
  if (!raw.startsWith('+')) return null;
  const digits = raw.slice(1);
  if (!/^\d{8,15}$/.test(digits)) return null;
  if (digits.startsWith('0')) return null;
  return '+' + digits;
}

function maskPhone(phone) {
  if (typeof phone !== 'string' || phone.length < 6) return '•••';
  return phone.slice(0, 3) + ' •••••• ' + phone.slice(-4);
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function nowIso() {
  return new Date().toISOString();
}

function isoPlusSeconds(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Sliding-window limiter held in memory. Single-process deployments only;
// document this if you scale horizontally.
class RateLimiter {
  constructor() {
    this.hits = new Map();
    this.lastSweep = Date.now();
  }

  check(key, limit, windowMs) {
    const now = Date.now();
    this.sweep(now, windowMs);
    const arr = (this.hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000)) };
    }
    arr.push(now);
    this.hits.set(key, arr);
    return { ok: true };
  }

  sweep(now, windowMs) {
    if (now - this.lastSweep < Math.max(windowMs, 60000)) return;
    this.lastSweep = now;
    for (const [key, arr] of this.hits) {
      const live = arr.filter((t) => now - t < windowMs);
      if (live.length) this.hits.set(key, live);
      else this.hits.delete(key);
    }
  }
}

function log(...args) {
  console.log('[' + nowIso() + ']', ...args);
}

module.exports = {
  HttpError,
  readJson,
  normalizePhone,
  maskPhone,
  haversineMeters,
  nowIso,
  isoPlusSeconds,
  uuid,
  sha256,
  constantTimeEqual,
  RateLimiter,
  log
};
