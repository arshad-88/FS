#!/usr/bin/env node
'use strict';
/*
 * Localization gate: FamilyShield ships English, Hindi and Telugu.
 *
 * Strings reach the UI from three places, and all three are loaded here so the
 * check reflects what a device actually sees:
 *   - js/i18n.base.js  → en + hi packs
 *   - js/i18n.te.js    → te pack
 *   - js/i18n.js       → FS.i18n API + the `cloud.*` SUPPLEMENT table
 *   - FS.i18n.addStrings({...}) payloads inside other modules (sos.js, helper.js)
 *
 * Reported:
 *   1. keys missing from a language (silently falls back to English at runtime),
 *   2. keys the UI asks for that nothing defines,
 *   3. raw keys / "[object Object]" / "undefined" / empty values,
 *   4. placeholders present in English but dropped by a translation,
 *   5. hi/te copy still identical to English prose (heuristic, warning only),
 *   6. keys that only exist at runtime instead of in a language pack (warning).
 *
 * Exit code 1 on any hard problem. Usage: node tools/check-i18n.js [--verbose]
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'app', 'assets', 'www');
const LANGS = ['en', 'hi', 'te'];
const PACKS = ['js/i18n.base.js', 'js/i18n.te.js', 'js/i18n.js'];

function makeSandbox() {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = undefined;
  return vm.createContext(sandbox);
}

function loadPacks() {
  const ctx = makeSandbox();
  for (const file of PACKS) {
    vm.runInContext(fs.readFileSync(path.join(WWW, file), 'utf8'), ctx, { filename: file });
  }
  const data = ctx.FS.i18nData || {};
  const out = {};
  for (const lang of LANGS) out[lang] = { ...(data[lang] || {}) };
  return { dict: out, ctx };
}

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

// Pull the object literal out of FS.i18n.addStrings({ ... }) and evaluate it so
// keys registered at load time count as defined.
function loadRuntimeStrings(dict, ctx) {
  const runtimeOnly = { en: [], hi: [], te: [] };
  for (const file of walk(WWW)) {
    if (!file.endsWith('.js') || /i18n(\.|$)/.test(path.basename(file))) continue;
    const src = fs.readFileSync(file, 'utf8');
    let idx = src.indexOf('addStrings(');
    while (idx !== -1) {
      let i = src.indexOf('{', idx);
      if (i === -1) break;
      let depth = 0;
      let end = -1;
      for (let j = i; j < src.length; j++) {
        const ch = src[j];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { end = j; break; }
        } else if (ch === "'" || ch === '"') {
          const quote = ch;
          for (j++; j < src.length; j++) {
            if (src[j] === '\\') j++;
            else if (src[j] === quote) break;
          }
        }
      }
      if (end === -1) break;
      let payload = null;
      try {
        payload = vm.runInContext(`(${src.slice(i, end + 1)})`, ctx);
      } catch (err) {
        console.log(`warn  ${path.relative(ROOT, file)}: addStrings payload not statically readable (${err.message})`);
      }
      if (payload) {
        for (const lang of LANGS) {
          for (const [key, value] of Object.entries(payload[lang] || {})) {
            if (!(key in dict[lang])) {
              dict[lang][key] = value;
              runtimeOnly[lang].push(key);
            }
          }
        }
      }
      idx = src.indexOf('addStrings(', end);
    }
  }
  return runtimeOnly;
}

function collectUsedKeys() {
  const used = new Map(); // key -> Set(source files)
  const add = (key, where) => {
    if (!/^[a-z][\w]*(\.[\w]+)+$/i.test(key)) return;
    if (!used.has(key)) used.set(key, new Set());
    used.get(key).add(where);
  };
  for (const file of walk(WWW)) {
    if (!/\.(js|html)$/.test(file)) continue;
    if (/i18n(\.|$)/.test(path.basename(file))) continue;
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const src = fs.readFileSync(file, 'utf8');
    let m;
    const attr = /data-i18n(?:-aria|-title|-placeholder|-label)?="([^"]+)"/g;
    while ((m = attr.exec(src))) add(m[1].trim(), rel);
    for (const re of [/\bt\(\s*'([^']+)'/g, /\bt\(\s*"([^"]+)"/g]) {
      while ((m = re.exec(src))) add(m[1], rel);
    }
  }
  return used;
}

const placeholders = (value) => new Set([...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

function main() {
  const verbose = process.argv.includes('--verbose');
  const { dict, ctx } = loadPacks();
  const runtimeOnly = loadRuntimeStrings(dict, ctx);
  const used = collectUsedKeys();
  const keysFile = path.join(ROOT, 'tools', 'i18n-keys.json');
  const extraUi = fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, 'utf8')).ui || [] : [];
  const canonical = new Set([...Object.keys(dict.en), ...extraUi]);

  const problems = [];
  const warnings = [];

  for (const lang of LANGS.slice(1)) {
    const missing = [...canonical].filter((k) => !dict[lang][k]);
    if (missing.length) {
      problems.push(`${lang}: ${missing.length} key(s) missing — ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''}`);
    }
  }

  for (const [key, where] of used) {
    if (!dict.en[key]) problems.push(`en: UI requests undefined key "${key}" (${[...where].join(', ')})`);
  }

  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(dict[lang])) {
      if (typeof value !== 'string') continue;
      if (!value.trim()) problems.push(`${lang}: "${key}" is empty`);
      if (value.trim() === key) problems.push(`${lang}: "${key}" renders its raw key`);
      const bad = value.match(/\[object Object\]|undefined\b/);
      if (bad) problems.push(`${lang}: "${key}" contains "${bad[0]}"`);
      const en = dict.en[key];
      if (lang !== 'en' && typeof en === 'string') {
        const lost = [...placeholders(en)].filter((p) => !placeholders(value).has(p));
        if (lost.length) problems.push(`${lang}: "${key}" lost placeholder(s) ${lost.join(', ')}`);
      }
    }
  }

  for (const lang of ['hi', 'te']) {
    const same = Object.keys(dict.en).filter(
      (k) => typeof dict.en[k] === 'string' && dict.en[k] === dict[lang][k] && dict.en[k].length > 3 && /[a-z]{3,} [a-z]{2,}/i.test(dict.en[k])
    );
    if (same.length) {
      warnings.push(`${lang}: ${same.length} string(s) identical to English — ${same.slice(0, 15).join(', ')}${same.length > 15 ? ', …' : ''}`);
      if (verbose) for (const k of same) console.log(`  ${lang} same-as-en: ${k} = ${JSON.stringify(dict.en[k])}`);
    }
    if (runtimeOnly[lang].length) {
      warnings.push(`${lang}: ${runtimeOnly[lang].length} key(s) only from addStrings(), not from a language pack — ${runtimeOnly[lang].slice(0, 12).join(', ')}${runtimeOnly[lang].length > 12 ? ', …' : ''}`);
    }
  }

  console.log(`i18n: ${LANGS.map((l) => `${l}=${Object.keys(dict[l]).length}`).join(' ')}; UI keys referenced=${used.size}`);
  for (const w of warnings) console.log(`warn  ${w}`);
  for (const p of problems) console.log(`FAIL  ${p}`);
  if (problems.length) {
    console.log(`\ni18n check FAILED with ${problems.length} problem(s).`);
    process.exit(1);
  }
  console.log('\ni18n check passed.');
}

main();
