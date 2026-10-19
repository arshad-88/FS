# FamilyShield — canonical i18n key manifest

Generated from `docs/CONTRACTS.md` §1a/§1b/§2b. **Machine-readable copy: `tools/i18n-keys.json`.**
Every language object must define **exactly** these keys — no more, no less.

* UI keys: 122
* Indicator keys: 118 (from 59 frozen indicator ids)
* Guidance keys: 17
* **Total per language: 257** (6 languages = 1542 strings)

## 1. UI keys (122)

* `app.disclaimerShort`
* `app.name` — FamilyShield (keep the English product name in Latin script in every language)
* `app.tagline`
* `common.add`
* `common.cancel`
* `common.close`
* `common.delete`
* `common.goBack`
* `common.ok`
* `common.save`
* `family.add`
* `family.alertBody`
* `family.alertIntro`
* `family.alertShared`
* `family.confirmRemove`
* `family.empty`
* `family.invalid`
* `family.name`
* `family.phone`
* `family.privacy`
* `family.remove`
* `family.save`
* `family.subtitle`
* `family.title`
* `guide.callHelpline`
* `guide.helpline1`
* `guide.helpline2`
* `guide.helpline3`
* `guide.helplineTitle`
* `guide.openCybercrime`
* `guide.r1.body`
* `guide.r1.title`
* `guide.r8.body`
* `guide.r8.title`
* `guide.reportTitle`
* `guide.subtitle`
* `guide.title`
* `guide.upiTitle`
* `history.clear`
* `history.clearConfirm`
* `history.deleted`
* `history.empty`
* `history.scannedOn`
* `history.summary`
* `history.title`
* `home.analyze`
* `home.example`
* `home.inputLabel`
* `home.paste`
* `home.placeholder`
* `home.privacyNote`
* `home.subtitle`
* `home.tipBody`
* `home.tipTitle`
* `home.title`
* `home.tryExampleLabel`
* `nav.family`
* `nav.guide`
* `nav.history`
* `nav.scan`
* `nav.settings`
* `navigator.language`
* `placeholder.none`
* `result.alertFamily`
* `result.back`
* `result.confidence.high`
* `result.confidence.low`
* `result.confidence.medium`
* `result.copy`
* `result.entities.amounts`
* `result.entities.domains`
* `result.entities.emails`
* `result.entities.phones`
* `result.entities.upi`
* `result.entities.urls`
* `result.found`
* `result.moreDetails`
* `result.nothingFound`
* `result.report`
* `result.scoreLabel`
* `result.title`
* `result.verdict.high`
* `result.verdict.high.sub`
* `result.verdict.safe`
* `result.verdict.safe.sub`
* `result.verdict.suspicious`
* `result.verdict.suspicious.sub`
* `result.whatToDo`
* `result.why`
* `settings.about`
* `settings.aboutBody`
* `settings.disclaimer`
* `settings.disclaimerBody`
* `settings.engineVersion`
* `settings.language`
* `settings.noPermissions`
* `settings.noPermissionsBody`
* `settings.offline`
* `settings.offlineBody`
* `settings.privacy`
* `settings.privacyBody`
* `settings.reset`
* `settings.title`
* `settings.version`
* `severity.high`
* `severity.low`
* `severity.medium`
* `summary.emptyText`
* `summary.high`
* `summary.nIndicators`
* `summary.safe`
* `summary.suspicious`
* `toast.cleared`
* `toast.copied`
* `toast.langChanged`
* `toast.needText`
* `toast.noFamily`
* `toast.offlineReady`
* `toast.removed`
* `toast.reportOpening`
* `toast.saved`
* `toast.shared`

## 2. Indicator keys (118)

Each frozen indicator id needs **both** `<id>.title` (2–4 words, shown as the chip) and
`<id>.detail` (one or two sentences: what we saw **and** what the user should do).

| id | title/detail hint |
| --- | --- |
| **url** — Unsafe link traits | (15 ids) |
| `url.shortener` | Link is hidden behind a short link (bit.ly, tinyurl, rb.gy…) |
| `url.ipLiteral` | Web address is a raw IP number instead of a name |
| `url.punycode` | Look-alike letters / xn-- encoding used to fake a brand domain |
| `url.manySubdomains` | Too many subdomains, real domain pushed to the end |
| `url.riskyTld` | Cheap or abuse-heavy domain ending (.xyz .top .tk .club…) |
| `url.lookalikeBrand` | Domain says it is a known company but is not |
| `url.brandInSubdomain` | Known bank/company name appears as a subdomain, not the real domain |
| `url.noTls` | Link is plain http:// with no lock (not https) |
| `url.atSign` | An @ inside the link can make it point somewhere else |
| `url.nonstandardPort` | Unusual port number (like :8080) in the address |
| `url.apkDownload` | Link downloads an app file (.apk) — never needed over chat |
| `url.actionPath` | Address contains words like login/verify/kyc/refund |
| `url.whatsappLink` | Link opens a chat that is not an official channel |
| `url.longQuery` | Very long query string, often hiding tracking or a second link |
| `url.withheldHost` | The real destination is impossible to tell from what is shown |
| **content** — Message content | (22 ids) |
| `content.urgency` | Pressure to act right now ("within 2 hours", "immediately") |
| `content.threat` | Threat of punishment, blocking or harm |
| `content.legalThreat` | Fake legal wording: FIR, court, police case, arrest |
| `content.digitalArrest` | So-called "digital arrest" / do not tell anyone, stay on video |
| `content.otpRequest` | Asks you to share an OTP |
| `content.credentialRequest` | Asks for PIN, password, CVV or full card details |
| `content.moneyBait` | Promise of money, prize, refund or cashback to pull you in |
| `content.jobBait` | Job, part-time or work-from-home offer |
| `content.loanBait` | Instant loan or pre-approved credit offer |
| `content.kycBait` | "Update your KYC or your account will be blocked" |
| `content.impostersGovt` | Pretending to be a government office (Income Tax, police, TRAI, RBI) |
| `content.impersonation` | Pretending to be your bank, a company or a known person |
| `content.remoteAccess` | Wants you to install AnyDesk/TeamViewer or share your screen |
| `content.refundDelivery` | Fake refund, cashback or "your parcel" story |
| `content.investmentBait` | Guaranteed-return trading, crypto or tip-group pitch |
| `content.familyEmergency` | Pretends a relative is in trouble and needs money now |
| `content.parcelCustoms` | Fake customs/parcel duty or illegal-item story |
| `content.electricityDisconnect` | "Your electricity will be cut tonight" |
| `content.simDeactivation` | "Your SIM/number will be deactivated today" |
| `content.secrecy` | Tells you to keep it secret from family or bank staff |
| `content.senderGenericGreeting` | Greeting with no name ("Dear Customer") from a numbered sender |
| `content.suspiciousSenderId` | Sent from an odd or unofficial sender ID |
| **money** — Money / UPI | (6 ids) |
| `money.collectRequest` | A UPI collect request to approve — approving PAYS money out |
| `money.upiPinRequest` | Asks for your UPI PIN |
| `money.receiveMisconception` | The "to receive money you must enter a PIN" lie |
| `money.sendMoneyUrgent` | Pushes you to send money quickly |
| `money.feeUpfront` | Pay a fee/charge/processing amount first |
| `money.qrToReceive` | A QR code claimed to be for receiving money (scanning pays out) |
| **manipulation** — Pressure tactics | (4 ids) |
| `manipulation.tooGood` | Sounds too good to be true |
| `manipulation.authority` | Acts as an authority, officer or senior official |
| `manipulation.fear` | Uses fear to stop you thinking |
| `manipulation.flattery` | Flattery or false friendship to gain trust |
| **obfuscation** — Tricks & hidden characters | (5 ids) |
| `obfuscation.zeroWidth` | Invisible zero-width characters hidden in the text |
| `obfuscation.homoglyph` | Look-alike characters used to fake words |
| `obfuscation.mixedScript` | Mixes scripts (Latin + Devanagari/Tamil) to slip past filters |
| `obfuscation.allCaps` | SHOUTING CAPS used for pressure |
| `obfuscation.excessiveEmoji` | Many emojis used to look official or urgent |
| **combo** — Dangerous combinations | (4 ids) |
| `combo.linkPlusCredentialRequest` | A link together with a request for credentials |
| `combo.impersonationPlusLookalike` | Impersonates a brand and uses a look-alike domain |
| `combo.urgencyPlusMoneyRequest` | Urgency plus a request for money |
| `combo.remoteAccessPlusThreat` | Remote-access app plus a threat |
| **protective** — Good signs (these lower the score) | (3 ids) |
| `protective.doNotShareWarning` | Message itself warns you never to share OTP/PIN (good sign) |
| `protective.noLinkPresent` | No link at all in the message (good sign) |
| `protective.transactionalOnly` | Ordinary transaction/invoice message with nothing suspicious (good sign) |

## 3. Guidance keys (17)

One short imperative sentence each, spoken to the user, no jargon.

* `guidance.neverShareOtp`
* `guidance.noUpiPinToReceive`
* `guidance.noCollectApprove`
* `guidance.dontClick`
* `guidance.useOfficialApp`
* `guidance.callOfficialNumber`
* `guidance.verifyIndependently`
* `guidance.dontInstallRemoteAccess`
* `guidance.stopScreenShare`
* `guidance.report1930`
* `guidance.reportCybercrime`
* `guidance.blockAndDelete`
* `guidance.alertFamily`
* `guidance.checkStatement`
* `guidance.neverPayFee`
* `guidance.talkToFamily`
* `guidance.calmDown`

## 4. Rules

* Native script for hi / ta / te / bn / mr. Only `app.name` stays in Latin script.
* Keep numbers, UPI, OTP, PIN, KYC, QR, 1930, 1915, cybercrime.gov.in in Latin script.
* English string may contain Hinglish helper text where it genuinely helps (e.g. "Do not share OTP — koi bhi OTP kabhi na batayein").
* No machine-translation artefacts, no placeholder text, no empty string.
* `{n}`, `{count}`, `{lang}`, `{version}` style `{placeholders}` must be preserved exactly where the runtime interpolates them.
* File shape: `FS_I18N.register('<code>', { ...keys... });` with UMD-safe guard (no bare `window` at load time).
