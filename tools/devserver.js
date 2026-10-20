#!/usr/bin/env node
'use strict';
/*
 * Desktop harness for the FamilyShield web UI.
 *
 * The APK loads app/assets/www inside a WebView and gets its backend origin from the
 * native bridge (FSAndroid.getBackendOrigin). Off-device there is no bridge, so this
 * server serves the exact same assets and injects a stand-in bridge that only answers
 * the two bridge calls the UI needs. Everything else — routing, i18n, cloud.js,
 * sos.js, helper.js — is the real shipped code, so browser runs exercise the same
 * paths as the device.
 *
 *   node tools/devserver.js [--port 8099] [--base http://127.0.0.1:8787]
 *
 * Then open http://127.0.0.1:8099/ with the API running (`node server/index.js`).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(getArg('--port', '8099'));
const BASE = getArg('--base', 'http://127.0.0.1:8787').replace(/\/+$/, '');
const WWW = path.join(__dirname, '..', 'app', 'assets', 'www');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

const BRIDGE = `<script>
  window.FSAndroid = {
    isFamilyShieldBridge: function () { return true; },
    getBackendOrigin: function () { return ${JSON.stringify(BASE)}; },
    versionName: 'dev-harness'
  };
</script>`;

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(WWW, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(WWW)) return send(res, 403, 'text/plain', 'forbidden');

  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'text/plain', `not found: ${rel}`);
    const ext = path.extname(file).toLowerCase();
    let body = buf;
    if (ext === '.html') {
      const html = buf.toString('utf8');
      const at = html.lastIndexOf('<script src="js/');
      body = Buffer.from(at === -1 ? html : `${html.slice(0, at)}${BRIDGE}\n${html.slice(at)}`, 'utf8');
    }
    send(res, 200, TYPES[ext] || 'application/octet-stream', body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`familyshield web harness on http://127.0.0.1:${PORT}/  (api ${BASE})`);
});
