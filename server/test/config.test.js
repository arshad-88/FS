'use strict';
/*
 * config.js freezes its values at require time, so each case boots a throwaway
 * child process instead of mutating the parent's environment.
 *
 * The rule under test: FS_DEV_MODE echoes OTPs to the server console, therefore
 * a production process (NODE_ENV=production) must never be able to enable it,
 * even if the variable is left behind in the deployed environment.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG = path.join(__dirname, '..', 'config.js');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'familyshield-config-'));
const SECRET = crypto.randomBytes(32).toString('hex');

function readDevMode(env) {
  const child = spawnSync(
    process.execPath,
    ['-e', 'const c = require(process.argv[1]); process.stdout.write(JSON.stringify({ devMode: c.devMode }));', CONFIG],
    {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, FS_DATA_DIR: DATA_DIR, FS_TOKEN_SECRET: SECRET, ...env },
      encoding: 'utf8'
    }
  );
  assert.strictEqual(child.status, 0, child.stderr || 'config.js failed to load');
  return { devMode: JSON.parse(child.stdout).devMode, stderr: child.stderr || '' };
}

test('dev mode stays off in production even when FS_DEV_MODE=1 is present', () => {
  const out = readDevMode({ NODE_ENV: 'production', FS_DEV_MODE: '1' });
  assert.strictEqual(out.devMode, false);
  assert.match(out.stderr, /FS_DEV_MODE is set but NODE_ENV=production/);
});

test('dev mode stays off in production by default', () => {
  const out = readDevMode({ NODE_ENV: 'production' });
  assert.strictEqual(out.devMode, false);
  assert.strictEqual(out.stderr.includes('FS_DEV_MODE'), false);
});

test('dev mode is honoured for local development', () => {
  const out = readDevMode({ NODE_ENV: 'development', FS_DEV_MODE: '1' });
  assert.strictEqual(out.devMode, true);
});
