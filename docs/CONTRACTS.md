# FamilyShield — frozen interface contracts

This file is the single source of truth for parallel work. **Do not change anything here without
telling the lead agent.** Every JavaScript file is a *classic script* (no `import`/`export`, no bundler,
no build step for the web layer). Globals are attached to `window.FS`.

Load order in `app/assets/www/index.html`:

```html
<script src="js/i18n.base.js"></script>   <!-- en, hi  (author: i18n-en) -->
<script src="js/i18n.south.js"></script>  <!-- ta, te  (author: i18n-south) -->
<script src="js/i18n.east.js"></script>   <!-- bn, mr  (author: i18n-east) -->
<script src="js/i18n.js"></script>        <!-- module + assembly (author: lead) -->
<script src="js/engine.js"></script>
<script src="js/app.js"></script>
```

Target runtime: Android WebView (Chromium). ES2020 is allowed (`const`, arrow functions, template
literals, optional catch binding, `Object.assign`, `String.prototype.normalize`, `Intl` best-effort).
Do **not** use ES modules, `??=`, `Array.prototype.at`, `structuredClone`, top-level await, or anything
newer than Chrome 80. `?.` and `??` are allowed but keep usage minimal.

The app declares **zero Android permissions and has no network access at all.** Nothing may fetch a URL,
load a remote font, or depend on a CDN. Everything is local.

---

## 1. `js/i18n.js` — localization

Exposes `window.FS.i18n`.

```js
FS.i18n = {
  version: '1.0.0',
  defaultLang: 'en',
  fallbackLang: 'en',
  langs: [                         // ordered; used to build the language picker
    { code: 'en', native: 'English',  english: 'English', rtl: false },
    { code: 'hi', native: 'हिन्दी',    english: 'Hindi',   rtl: false },
    { code: 'ta', native: 'தமிழ்',    english: 'Tamil',   rtl: false },
    { code: 'te', native: 'తెలుగు',    english: 'Telugu',  rtl: false },
    { code: 'bn', native: 'বাংলা',     english: 'Bengali', rtl: false },
    { code: 'mr', native: 'मराठी',     english: 'Marathi', rtl: false }
  ],
  strings: { en: { 'key': 'value', ... }, hi: {...}, ta: {...}, te: {...}, bn: {...}, mr: {...} },
  has(lang, key) -> boolean,
  t(key, lang, params) -> string,   // never throws; unknown key returns the key itself;
                                    // unknown lang falls back to en, then returns key
  detect() -> lang,                 // navigator.language match against langs, else defaultLang
  formatNumber(n, lang) -> string    // best-effort, must not throw
};
```

`t()` must interpolate `{name}` placeholders from `params` (e.g. `'{n} risks found'` + `{n:3}`).

### 1a. Required UI keys (every language must define all of these)

```
app.name, app.tagline, app.disclaimerShort
nav.scan, nav.guide, nav.family, nav.history, nav.settings
home.title, home.subtitle, home.inputLabel, home.placeholder, home.analyze,
home.paste, home.example, home.tryExampleLabel, home.privacyNote, home.tipTitle, home.tipBody
result.title, result.scoreLabel, result.why, result.found, result.nothingFound,
result.whatToDo, result.back, result.alertFamily, result.report, result.copy, result.moreDetails
result.verdict.safe, result.verdict.suspicious, result.verdict.high
result.verdict.safe.sub, result.verdict.suspicious.sub, result.verdict.high.sub
result.confidence.high, result.confidence.medium, result.confidence.low
result.entities.urls, result.entities.domains, result.entities.upi, result.entities.phones,
result.entities.amounts, result.entities.emails
guide.title, guide.subtitle, guide.upiTitle, guide.reportTitle, guide.helplineTitle
guide.r1.title ... guide.r8.title, guide.r1.body ... guide.r8.body
guide.helpline1, guide.helpline2, guide.helpline3, guide.callHelpline, guide.openCybercrime
family.title, family.subtitle, family.empty, family.add, family.name, family.phone,
family.save, family.remove, family.alertIntro, family.alertShared, family.privacy, family.invalid,
family.confirmRemove, family.alertBody
history.title, history.summary, history.empty, history.clear, history.clearConfirm, history.deleted,
history.scannedOn
settings.title, settings.language, settings.about, settings.aboutBody, settings.privacy,
settings.privacyBody, settings.noPermissions, settings.noPermissionsBody, settings.offline,
settings.offlineBody, settings.disclaimer, settings.disclaimerBody, settings.version,
settings.engineVersion, settings.reset
severity.high, severity.medium, severity.low
summary.safe, summary.suspicious, summary.high, summary.nIndicators, summary.emptyText
common.cancel, common.save, common.ok, common.close, common.goBack, common.delete, common.add
toast.copied, toast.saved, toast.removed, toast.cleared, toast.needText, toast.noFamily,
toast.shared, toast.reportOpening, toast.langChanged, toast.offlineReady
placeholder.none
```

### 1b. Required engine keys

Every indicator id in §2 must have `ind.<id>.title` and `ind.<id>.detail`.
Plus these shared keys:

```
guidance.neverShareOtp, guidance.noUpiPinToReceive, guidance.noCollectApprove,
guidance.dontClick, guidance.useOfficialApp, guidance.callOfficialNumber,
guidance.verifyIndependently, guidance.dontInstallRemoteAccess, guidance.stopScreenShare,
guidance.report1930, guidance.reportCybercrime, guidance.blockAndDelete, guidance.alertFamily,
guidance.checkStatement, guidance.neverPayFee, guidance.talkToFamily, guidance.calmDown
```

Translation quality bar: `en`, `hi`, `ta`, `te`, `bn`, `mr` must all be real, natural translations
written in the native script (not transliteration, not English placeholders). Keep sentences short and
plain-language — the audience is parents and elderly users, not security engineers. Fallback to `en`
is allowed only if a string genuinely cannot be translated; never leave a key missing from `en`.

---

## 2. `js/engine.js` — the scan engine

Exposes `window.FS.Engine`. Pure, synchronous, deterministic, no DOM, no i18n text (keys only), no
network, no globals other than `window.FS.Engine`. Must never throw for any input, including
`null`, `undefined`, numbers, objects, 1 MB strings, control characters, or unpaired surrogates.

```js
FS.Engine = {
  version: '1.0.0',
  engineName: 'FamilyShield Heuristics',
  MAX_INPUT: 20000,                     // analyse at most this many chars, truncate beyond
  analyze(input, opts) -> Report,       // opts: { lang?: string }  (lang is echoed, not used for text)
  analyzeUrl(url) -> UrlReport,         // helper, used by analyze() and by app for a single link
  classifyLink(text) -> { href, host, kind }  // kind: 'url'|'email'|'upi'|'phone'|'none'
};
```

### Report

```js
{
  empty: false,                  // true when input had no meaningful content
  score: 0,                      // integer 0..100, higher = riskier
  band: 'safe',                  // 'safe' | 'suspicious' | 'high'
  confidence: 0.0,               // 0..1
  counts: { high: 0, medium: 0, low: 0 },
  indicators: [Indicator],       // sorted: severity (high>medium>low), then |weight| desc
  protective: [Indicator],       // indicator ids that REDUCED risk (see de-escalators)
  entities: {
    urls: [], domains: [], upiIds: [], phones: [], amounts: [], emails: [], otpMentions: 0
  },
  summaryKey: 'summary.safe',    // i18n key
  summaryParams: { n: 0 },
  guidanceKeys: ['guidance...']  // ordered, de-duplicated i18n keys
}
```

### Indicator

```js
{
  id: 'url.shortener',           // stable, dotted machine id (used to build ind.<id>.title/.detail)
  family: 'url'|'content'|'sender'|'money'|'manipulation'|'obfuscation',
  severity: 'high',              // 'high' | 'medium' | 'low'
  weight: 18,                    // positive adds risk, negative reduces risk
  titleKey: 'ind.url.shortener.title',
  detailKey: 'ind.url.shortener.detail',
  params: {},                    // {host: '...'} etc. for {placeholders}
  evidence: ['bit.ly/xY3'],      // raw matched substrings, max 4, each <= 80 chars, for display
  protective: false              // true for de-escalators
}
```

### Scoring rules (must match exactly)

* `score = clamp(0, 100, sum(weight of non-protective indicators) + sum(weight of protective))`,
  protective weights are negative.
* Bands: `score >= 60 -> 'high'`, `score >= 25 -> 'suspicious'`, else `'safe'`.
* Floor rules (apply after summing):
  * any non-protective indicator with `severity:'high' && weight >= 30` -> band at least `'suspicious'`,
    and if `score < 60` raise `score` to `60` when the indicator id starts with `money.` or
    `content.impersonation` or `url.lookalike` or `content.remoteAccess`.
  * `empty: true` -> `score 0`, `band 'safe'`, `confidence 0`.
* `confidence` = 0.35 + 0.5 * (number of distinct triggered families / 5), clamped to 1.0, rounded to 2 dp.
  With no indicators, confidence is `0.5` (cannot prove safety, only absence of known signals).

### Required detection coverage

URL signals (family `url`) — at least: `url.shortener`, `url.ipLiteral`, `url.punycode`,
`url.manySubdomains`, `url.riskyTld`, `url.lookalikeBrand`, `url.brandInSubdomain`, `url.noTls`,
`url.atSign`, `url.nonstandardPort`, `url.apkDownload`, `url.actionPath` (login/verify/kyc/otp/update/
unblock/refund/claim/reward), `url.whatsappLink`, `url.longQuery`, `url.withheldHost`.

Content signals (family `content`) — at least: `content.urgency`, `content.threat`,
`content.legalThreat`, `content.digitalArrest`, `content.otpRequest`, `content.credentialRequest`,
`content.moneyBait`, `content.jobBait`, `content.loanBait`, `content.kycBait`, `content.impostersGovt`,
`content.impersonation`, `content.remoteAccess`, `content.refundDelivery`, `content.investmentBait`,
`content.familyEmergency`, `content.parcelCustoms`, `content.electricityDisconnect`,
`content.simDeactivation`, `content.secrecy`, `content.senderGenericGreeting`, `content.suspiciousSenderId`.

Money signals (family `money`) — at least: `money.collectRequest`, `money.upiPinRequest`,
`money.receiveMisconception`, `money.sendMoneyUrgent`, `money.feeUpfront`, `money.qrToReceive`.

Manipulation / obfuscation (families `manipulation`, `obfuscation`) — at least:
`manipulation.tooGood`, `manipulation.authority`, `manipulation.fear`, `manipulation.flattery`,
`obfuscation.zeroWidth`, `obfuscation.homoglyph`, `obfuscation.mixedScript`, `obfuscation.allCaps`,
`obfuscation.excessiveEmoji`.

Combination rules (these are the high-confidence ones and must exist):
`combo.linkPlusCredentialRequest`, `combo.impersonationPlusLookalike`,
`combo.urgencyPlusMoneyRequest`, `combo.remoteAccessPlusThreat`.

Protective / de-escalators (negative weight, `protective: true`) — at least:
`protective.doNotShareWarning` ("do not share this OTP with anyone", "किसी के साथ साझा न करें" ...),
`protective.noLinkPresent`, `protective.transactionalOnly` (a plain debit/credit alert with amount +
merchant and no link and no action request). These must fire on genuine bank OTP alerts and genuine
transaction alerts so those come back `safe`.

Multilingual: the content lexicons must cover Devanagari (hi/mr), Tamil, Telugu and Bengali script
keywords in addition to English, and common Hinglish forms (`turant`, `abhi`, `kYC karwa lo`,
`paisa bhej`, `aapka khata band`, `OTP batao`, `link par click karo`, ...). Normalize with
`String.prototype.normalize('NFKC')` plus a lowercase step and an internal whitespace collapse before
matching; keep the *evidence* strings as the raw original substrings.

### 2a. Test suite (required deliverable)

* `tools/engine-cases.json` — at least **36** cases: `{ name, lang, input, expectBand, expectAny: [ids],
  expectNotAny: [ids], note }`. Must include:
  * legit bank OTP alert, legit debit alert, legit delivery notice, legit appointment reminder,
    legit exam-result notice, legit electricity bill (no link) -> `safe`
  * KYC-expiry phishing link, lottery/prize, digital arrest, electricity disconnection,
    SIM deactivation, job/part-time bait, instant-loan fee, refund/parcel customs, remote-access
    (AnyDesk) support scam, investment/Telegram tip group, UPI collect-request trick, "new number"
    family emergency, lookalike bank domain, punycode domain, shortener + KYC -> `high`
  * ambiguous newsletter/promo with a link -> `safe` or `suspicious` (assert what the engine does, and
    justify in `note`)
  * at least 6 cases whose input is in hi / ta / te / bn / mr script
* `tools/test-engine.mjs` — plain Node ESM, no dependencies. Loads `i18n.js` and `engine.js` into a
  sandbox with `vm`, runs every case, prints a per-case PASS/FAIL table plus a summary, exits non-zero
  on any failure. Also asserts:
  * every `titleKey`/`detailKey`/`summaryKey`/`guidanceKey` emitted by the engine exists in the `en`
    dictionary, and in every other language dictionary (or is present in `en` and listed in a
    documented `KNOWN_UNTRANSLATED` allowlist that is empty for `hi`)
  * every id in `expectAny` is reachable from some case in the corpus
  * `analyze(null)`, `analyze(undefined)`, `analyze(123)`, `analyze({})`, `analyze('')`,
    `analyze('a'.repeat(200000))`, `analyze('\uD800')` do not throw
  * the same input twice yields an identical JSON report (determinism)
* Run it with: `node tools/test-engine.mjs` and paste the final summary in your report.

---

## 3. `css/theme.css` — design system (owned by the UI workstream)

Single stylesheet, no frameworks, no remote imports. Mobile-first, dark, glassy.
`app/assets/www/styleguide.html` must render every token and component with the real markup.

### 3a. Design tokens — exact names, `:root`

```
--fs-primary:#9D72FF  --fs-secondary:#201938  --fs-tertiary:#181427  --fs-neutral:#FFFFFF
--fs-surface:#9D72FF  --fs-accent:#9D72FF
--fs-bg:#181427  --fs-bg-2:#201938  --fs-text:#FFFFFF  --fs-text-2:#181427
--fs-border:rgba(255,255,255,.25)  --fs-border-soft:rgba(255,255,255,.14)
--fs-glass:rgba(255,255,255,.06)   --fs-glass-2:rgba(255,255,255,.03)

--fs-ok:#9D72FF        /* calm = safe, deliberately the accent, not green */
--fs-warn:#F3C77E      /* suspicious — new semantic state, warm amber */
--fs-danger:#FF7A9A    /* high risk — new semantic state, sits in the palette's pink family
                          (the gradient shell already uses rgb(239,155,188)) */
--fs-danger-deep:#E0567C
--fs-shell-grad:linear-gradient(155deg,#7565DD 0%,#9C6CDF 45%,#EF9BBC 100%)

--fs-radius-md:16px  --fs-radius-lg:25.6px  --fs-radius-xl:40.8px
--fs-radius-2xl:48px --fs-radius-full:9999px

--fs-space-1:4px --fs-space-2:8px --fs-space-3:12px --fs-space-4:16px --fs-space-5:20px
--fs-space-6:24px --fs-space-7:28px --fs-space-8:32px --fs-gap:4px

--fs-blur:24px --fs-blur-sm:12px
--fs-shadow:0 25px 50px -12px rgba(0,0,0,.4)
--fs-shadow-sm:0 10px 15px -3px rgba(95,65,139,.1),0 4px 6px -4px rgba(95,65,139,.1)
--fs-focus:0 0 0 2px rgba(155,114,220,1)
--fs-ease:ease  --fs-dur:180ms
--fs-tabbar-h:64px
```

Typography: `Inter` first with a full CJK/Indic fallback chain
(`Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Devanagari",
"Noto Sans Tamil", "Noto Sans Telugu", "Noto Sans Bengali", sans-serif`).
Declare `@font-face` for `Inter` 400/500/600 from `../fonts/Inter-Regular.woff2`,
`../fonts/Inter-Medium.woff2`, `../fonts/Inter-SemiBold.woff2` with `font-display: swap`
(the lead agent supplies those files; the fallback chain must look right without them).
`--fs-font-mono` = `"Roboto Mono", ui-monospace, monospace` for evidence/URL text.

- `.display` → 60px/60px 400, letter-spacing -0.025em, fluid down to 36px on phones
- `.h1` 32px, `.h2` 20px, `.h3` 16px, `.body` 14px/20px 400, `.small` 12px, `.tiny` 11px
- `.muted` → `rgba(255,255,255,.62)`, `.numeric` → `font-variant-numeric: tabular-nums`

### 3b. Required class names (exact; these are what `index.html` uses)

Layout: `.app`, `.app__main`, `.content`, `.topbar`, `.topbar__title`, `.topbar__brand`,
`.topbar__actions`, `.view`, `.view.is-active`, `.stack`, `.stack--sm`, `.stack--lg`, `.row`,
`.row--between`, `.row--center`, `.row--wrap`, `.grid`, `.grid--2`, `.grid--3`, `.divider`,
`.section`, `.section__head`, `.section__title`, `.section__sub`

Surfaces: `.glass`, `.glass--soft`, `.glass--strong`, `.card`, `.card--pad-sm`, `.shell-gradient`,
`.shell-gradient__inner`, `.hero`

Controls: `.btn`, `.btn--primary`, `.btn--ghost`, `.btn--link`, `.btn--danger`, `.btn--icon`,
`.btn--block`, `.btn.is-loading`, `.input`, `.textarea`, `.select`, `.field`, `.field__label`,
`.chip`, `.chip--accent`, `.chip--mono`, `.pill`, `.pill--high`, `.pill--medium`, `.pill--low`,
`.pill--safe`, `.badge`, `.avatar`

Verdict: `.verdict`, `.verdict--safe`, `.verdict--suspicious`, `.verdict--high`, `.verdict__icon`,
`.verdict__label`, `.verdict__summary`, `.score-ring` (conic-gradient ring driven by inline
`--score: 0..100` and `--ring-color`), `.score-ring__value`, `.score-ring__unit`, `.meter`,
`.meter__bar`, `.progress`, `.progress__bar`

Lists: `.list`, `.list__row`, `.list__lead`, `.list__body`, `.list__title`, `.list__meta`,
`.list__actions`, `.indicator`, `.indicator__head`, `.indicator__title`, `.indicator__body`,
`.indicator__evidence`, `.indicator--high`, `.indicator--medium`, `.indicator--low`, `.empty`,
`.empty__icon`, `.empty__title`, `.empty__body`, `.guide`, `.guide__item`, `.guide__num`,
`.alert-box`, `.alert-box--warn`, `.alert-box--danger`

Nav / chrome: `.tabbar`, `.tabbar__item`, `.tabbar__item.is-active`, `.tabbar__icon`, `.tabbar__label`,
`.icon`, `.icon--lg`, `.icon--sm`, `.sheet`, `.sheet.is-open`, `.sheet__panel`, `.sheet__head`,
`.sheet__body`, `.sheet__actions`, `.sheet__scrim`, `.toast`, `.toast.is-visible`

Utilities: `.is-hidden`, `.is-disabled`, `.truncate`, `.mono`, `.sr-only`, `.grow`, `.nowrap`

### 3c. Hard visual rules

* Dark glass first: surfaces are translucent white-on-plum with `backdrop-filter: blur(...)` **and**
  `-webkit-backdrop-filter`, `0.8px` borders, `--fs-shadow`. Logos/hero use `.shell-gradient`.
* `.shell-gradient` = gradient border shell: outer element with `padding: 0`, radius `0 0 44px 44px`
  on the hero variant, the gradient on a pseudo-element/background, and `.shell-gradient__inner`
  inset by ~1px with `--fs-radius-lg`.
* Every radius must come from the token family. Every gap/margin/padding must be a multiple of 4px.
* Motion: minimal — only `transition: ... var(--fs-dur) var(--fs-ease)` on hover/active/state changes.
  Wrap non-essential animation in `@media (prefers-reduced-motion: reduce)`.
* Accessibility: visible `:focus-visible` ring using `--fs-focus`; min 44px touch targets for buttons,
  tabbar items and list rows; `aria-hidden` decorative icons; colour contrast >= 4.5:1 for body text
  on the plum background (check white-on-plum and the amber/pink accents).
* Safe areas: `padding-bottom: env(safe-area-inset-bottom)` on `.tabbar`, and the app must never hide
  content behind the tabbar.
* No `@import`, no external URLs, no webfont from a CDN, no `<img>` pointing outside `assets/www/`.
* All icons are **inline SVG authored in-house** in Solar's *linear* style: 24×24 viewBox,
  `fill="none"`, `stroke="currentColor"`, `stroke-width="1.5"`, round caps/joins.

---

## 4. DOM contract (owned by the lead agent — `index.html`)

Views are `<section class="view" id="view-<name>" data-view="<name>">` for
`scan | result | guide | family | history | settings`; exactly one has `.is-active`.
The tabbar has `<button class="tabbar__item" data-nav="scan|guide|family|history|settings">`.

Optional sub-page: `id="view-account" data-view="account"` hosts the cloud/account module
(`js/cloud.js`, namespace `FS.cloud`, mounts into `#cloud-root`). It is **not** a tabbar item —
it is reached from Settings via `btn-open-account` and returns via `btn-account-back`, so while it
is active no `.tabbar__item` carries `.is-active`. `app.js` calls `FS.cloud.init()` once at boot and
`FS.cloud.onView(view)` on every navigation; `FS.cloud` may be absent, so both calls are guarded.

IDs the lead agent uses in `app.js` (do not rename, do not write `app.js`):

`scan-input`, `btn-analyze`, `btn-paste`, `btn-example`, `input-hint`, `char-count`,
`result-body`, `result-verdict`, `result-score`, `result-score-ring`, `result-summary`,
`result-confidence`, `result-indicators`, `result-entities`, `result-guidance`, `result-actions`,
`btn-result-back`, `btn-alert-family`, `btn-report`, `btn-copy`, `btn-detail`,
`guide-rules`, `guide-helpline`, `btn-open-cybercrime`, `btn-call-helpline`,
`family-list`, `btn-add-family`, `family-sheet`, `family-name`, `family-phone`, `btn-save-family`,
`family-cancel`, `history-list`, `history-summary`, `btn-clear-history`, `history-clear-sheet`,
`history-confirm-clear`, `history-cancel-clear`, `lang-select`, `settings-version`,
`settings-engine-version`, `btn-reset`, `toast`,
`btn-open-account`, `btn-account-back`, `cloud-root`

`app.js` calls the native bridge through `window.FSAndroid` (may be undefined in a desktop browser —
guard every call): `shareText(text)`, `copyText(text)`, `openUrl(url)`, `dial(number)`,
`consumeSharedText()`, `platformInfo()`, `log(text)`.

---

## 5. Verification each workstream must run

* Engine: `node tools/test-engine.mjs` → all cases pass, exit code 0.
* UI: open `app/assets/www/styleguide.html` in a browser (the lead agent will screenshot it) and confirm
  every token and component renders; run `visual_audit_html` on it and fix real a11y findings.
* Neither workstream may create scratch files at the repo root, and neither may modify files owned by
  the other workstream or `docs/`, `app/AndroidManifest.xml`, `app/java/**`, `tools/build.py`.

---

## 1c. i18n file split (added by the lead agent)

To let three authors translate in parallel without touching the same file, i18n data is split by language
group. **Runtime load order is the 4-script block in §1; nothing else loads i18n.**

Each data file is a *classic script* with this exact shape at top level:

```js
window.FS = window.FS || {};
FS.i18nData = FS.i18nData || { en: {}, hi: {}, ta: {}, te: {}, bn: {}, mr: {} };
FS.i18nData.<lang> = { /* flat 'a.b.c': 'string', ... */ };
```

* `js/i18n.base.js`  -> `FS.i18nData.en`, `FS.i18nData.hi`
* `js/i18n.south.js` -> `FS.i18nData.ta`, `FS.i18nData.te`
* `js/i18n.east.js`  -> `FS.i18nData.bn`, `FS.i18nData.mr`
* `js/i18n.js` (lead) -> sets `FS.i18n.strings = FS.i18nData`, implements the §1 i18n API, and itself
  contains no language strings.

Rule: keys are identical across languages. `en` is the reference; every other language must define
**exactly** the same key set (a missing key is a defect, not a fallback).

## 2b. Frozen indicator-id catalogue (added by the lead agent)

The id lists in §2 are **exactly** these 59 ids — not "at least". `engine.js` must emit only these ids;
i18n must define `ind.<id>.title` and `ind.<id>.detail` for exactly these.

* `url` (15): shortener, ipLiteral, punycode, manySubdomains, riskyTld, lookalikeBrand, brandInSubdomain,
  noTls, atSign, nonstandardPort, apkDownload, actionPath, whatsappLink, longQuery, withheldHost
* `content` (22): urgency, threat, legalThreat, digitalArrest, otpRequest, credentialRequest, moneyBait,
  jobBait, loanBait, kycBait, impostersGovt, impersonation, remoteAccess, refundDelivery, investmentBait,
  familyEmergency, parcelCustoms, electricityDisconnect, simDeactivation, secrecy,
  senderGenericGreeting, suspiciousSenderId
* `money` (6): collectRequest, upiPinRequest, receiveMisconception, sendMoneyUrgent, feeUpfront, qrToReceive
* `manipulation` (4): tooGood, authority, fear, flattery
* `obfuscation` (5): zeroWidth, homoglyph, mixedScript, allCaps, excessiveEmoji
* `combo` (4): linkPlusCredentialRequest, impersonationPlusLookalike, urgencyPlusMoneyRequest,
  remoteAccessPlusThreat
* `protective` (3): doNotShareWarning, noLinkPresent, transactionalOnly

Total: 59 ids x 2 strings = **118 `ind.*` strings per language**, plus the 17 `guidance.*` keys in §2.

## 6. Build & packaging (owned by the lead agent)

Gradle is **not** used. The APK is built with the staged command-line SDK:
`aapt2 compile` -> `aapt2 link -A app/assets` -> `javac --release 17` -> `d8` -> add `classes.dex` ->
`zipalign -p 4` -> `apksigner sign`.

* Package / applicationId: `com.familyshield.app`; `minSdk 24`, `targetSdk 34`; version 1.0 / 1.
* Permissions: **none**. No `INTERNET` permission — the app is genuinely offline.
* Native bridge is `window.FSAndroid` (§4) plus `storeGet(key)` / `storeSet(key, json)` backed by
  `SharedPreferences`, so history and the family list persist where `file://` WebView storage is
  unreliable. `app.js` prefers `FSAndroid.storeGet/storeSet`, then `localStorage`, then in-memory.
* Web layer ships from `app/assets/www/` and loads as `file:///android_asset/www/index.html`.
* Icons: adaptive icon (`mipmap-anydpi-v26`) plus legacy PNG mipmaps for API 24/25.
* Output: `dist/FamilyShield-1.0-debug.apk`, signed with a generated debug keystore
  (`build/debug.keystore`, alias `androiddebugkey`, store/key pass `android`).
* Entry point: `python tools/build.py` (also `--clean`, `--no-install`).

Ownership: `js/i18n.js`, `js/app.js`, `app/assets/www/index.html`, `app/AndroidManifest.xml`,
`app/java/**`, `app/res/**`, `tools/build.py`, `docs/**` are the lead agent's. `js/engine.js`,
`tools/test-engine.mjs`, `tools/engine-cases.json` are the engine workstream's. `css/theme.css` and
`app/assets/www/styleguide.html` are the UI workstream's. Each `js/i18n.*.js` data file belongs to its own
i18n workstream. No workstream writes outside its own files.
