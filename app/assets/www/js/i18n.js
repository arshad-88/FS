/*
 * FamilyShield — i18n module (owner: lead agent)
 * Contract: docs/CONTRACTS.md §1 and §1c.
 *
 * This module assembles FS.i18nData (populated by i18n.base.js, which carries the
 * `en` and `hi` packs, and i18n.te.js, which carries the `te` pack) and exposes the
 * read-only FS.i18n API.
 *
 * Shipped languages in this build: en, hi, te. Those three packs define every key
 * listed in tools/i18n-keys.json; the only keys that still live outside the packs
 * are the `cloud.*` strings in SUPPLEMENT below.
 *
 * Single deliberate exception to "no strings here": the SUPPLEMENT table further down
 * carries the `cloud.*` keys that js/cloud.js requests as t('key', 'english fallback')
 * and that the language packs do not define yet. Without it the whole Family / cloud
 * panel falls back to English for Hindi and Telugu users. Pack values always win and
 * nothing is ever overwritten — see mergeSupplement(). Once a key lands in the packs,
 * the pack copy is what users get, so the supplement can shrink or be deleted.
 *
 * Classic script. No import/export, no bundler, no network. ES2020 subset (Chrome 80 safe).
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  root.FS = root.FS || {};

  // Languages that actually ship a complete string pack in this build. `available()`
  // filters on non-empty packs, but a code must not appear here at all until its pack
  // exists — otherwise normalizeLang() would accept it and silently fall back to `en`.
  // Re-add e.g. ta / bn / mr here only together with a new i18n.<lang>.js pack.
  var LANGS = [
    { code: 'en', native: 'English', english: 'English', rtl: false },
    { code: 'hi', native: 'हिन्दी', english: 'Hindi', rtl: false },
    { code: 'te', native: 'తెలుగు', english: 'Telugu', rtl: false }
  ];

  var DEFAULT_LANG = 'en';
  var FALLBACK_LANG = 'en';

  // ---------------------------------------------------------------------------
  // SUPPLEMENT — keys requested by js/cloud.js as t(key, englishFallback).
  //
  // These are real UI strings, kept here only because the language packs do not
  // define them yet. mergeSupplement() copies them into FS.i18nData without ever
  // overwriting a pack value, so editing a pack is always the winning change.
  // Only en/hi/te are covered; ta/bn/mr are not shipped in this build.
  // ---------------------------------------------------------------------------
  var SUPPLEMENT = {
    en: {
      'cloud.rateLimited': 'Too many attempts. Please wait and retry.',
      'cloud.unreachable': 'Server unreachable. Check the API address and your connection.',
      'cloud.phone': 'Phone number',
      'cloud.code': '6-digit code',
      'cloud.sendCode': 'Send code',
      'cloud.verify': 'Verify',
      'cloud.invalidPhone': 'Enter the number with country code, e.g. +919876543210.',
      'cloud.devCode': 'Development code',
      'cloud.devHint': 'Development mode: the code is printed on the server console.',
      'cloud.codeSent': 'Code sent. It expires in a few minutes.',
      'cloud.invalidCode': 'Enter the 6-digit code from the SMS.',
      'cloud.signedIn': 'Signed in.',
      'cloud.signInTitle': 'Sign in with your phone',
      'cloud.signInHint': 'We text a one-time code to verify this number. Family links require the other person to approve.',
      'cloud.noName': 'No display name yet',
      'cloud.signOut': 'Sign out',
      'cloud.signedOut': 'Signed out.',
      'cloud.displayName': 'Your name (shown to your family)',
      'cloud.saveName': 'Save name',
      'cloud.nameSaved': 'Name saved.',
      'cloud.familyTitle': 'Family circle',
      'cloud.familyHint': 'Adding a number sends an invitation. They must sign in and approve before any location or alert can reach them.',
      'cloud.invitePhone': 'Family member phone number',
      'cloud.inviteName': 'Their name (optional)',
      'cloud.invite': 'Send invitation',
      'cloud.alreadyFamily': 'You are now connected.',
      'cloud.inviteSent': 'Invitation sent. It stays pending until they approve.',
      'cloud.pending': 'Pending approval',
      'cloud.accepted': 'Connected',
      'cloud.declined': 'Declined',
      'cloud.revoked': 'Removed',
      'cloud.consentTitle': 'Connected family',
      'cloud.noFamily': 'No family members yet. Invite someone above.',
      'cloud.unnamed': 'Unnamed contact',
      'cloud.locationConsent': 'Location sharing on',
      'cloud.approve': 'Approve',
      'cloud.approved': 'Connection approved.',
      'cloud.remove': 'Remove',
      'cloud.removed': 'Removed.',
      'cloud.incomingTitle': 'Waiting for your approval',
      'cloud.wantsToConnect': 'wants to connect as family',
      'cloud.decline': 'Decline',
      'cloud.declinedNote': 'Declined.',
      'cloud.ocrTitle': 'Scan a screenshot',
      'cloud.ocrHint': 'On-device text recognition. The image is processed locally and never uploaded.',
      'cloud.ocrPlaceholder': 'Extracted text appears here and is sent into the checker.',
      'cloud.ocrDone': 'Text extracted on device.',
      'cloud.ocrEmpty': 'No readable text found in that image.',
      'cloud.chooseScreenshot': 'Choose screenshot',
      'cloud.ocrUnsupported': 'This device could not read that image. You can paste the text manually.',
      'cloud.ocrPath': 'Absolute image path',
      'cloud.extract': 'Extract text',
      'cloud.ocrPathRequired': 'Enter the full path of a screenshot on this device.',
      'cloud.ocrToChecker': 'Use in checker',
      'cloud.sessionExpired': 'Your session expired. Sign in again.',
      'cloud.forbidden': 'You are not allowed to do that.',
      'cloud.notFound': 'That item no longer exists.',
      'cloud.alreadyRequested': 'There is already a pending request with this number.',
      'cloud.alreadyConnected': 'You are already connected with this person.',
      'cloud.notOptedIn': 'Enable nearby-helper duty in your alerts first.',
      'cloud.stateConflict': 'The emergency changed state. Refresh and try again.',
      'cloud.noSmsProvider': 'SMS delivery is not configured on the server yet.',
      'cloud.deliveryFailed': 'The code could not be delivered. Try again in a moment.',
      'cloud.requestFirst': 'Request a code first.',
      'cloud.nameInvalid': 'Enter a name of 1 to 60 characters.',
      'cloud.requestSent': 'Request sent. It stays pending until they approve.',
      'cloud.cancelled': 'Cancelled',
      'cloud.connected': 'Connected',
      'cloud.removedState': 'Removed',
      'cloud.since': 'Connected since',
      'cloud.alertsOn': 'Gets your emergency alerts',
      'cloud.invitedYou': 'invited you to their family circle',
      'cloud.outgoingTitle': 'Sent by you',
      'cloud.awaitingSignup': 'Waiting for them to sign in',
      'cloud.awaitingApproval': 'Waiting for their approval',
      'cloud.prefsTitle': 'Consents',
      'cloud.prefsHint': 'Each consent is independent: alerts never imply location sharing or helper duty.',
      'cloud.prefAlerts': 'Alert my family in an emergency',
      'cloud.prefLocation': 'Share my location when I raise an emergency',
      'cloud.prefHelper': 'Let me act as a nearby helper',
      'cloud.prefsSaved': 'Preference saved.'
    },
    hi: {
      'cloud.rateLimited': 'बहुत बार कोशिश हो गई। कृपया थोड़ी देर रुककर फिर कोशिश करें।',
      'cloud.unreachable': 'सर्वर से संपर्क नहीं हुआ। API पता और अपना इंटरनेट कनेक्शन जाँचें।',
      'cloud.phone': 'फ़ोन नंबर',
      'cloud.code': '6 अंकों का कोड',
      'cloud.sendCode': 'कोड भेजें',
      'cloud.verify': 'पुष्टि करें',
      'cloud.invalidPhone': 'देश कोड के साथ नंबर लिखें, जैसे +919876543210।',
      'cloud.devCode': 'डेवलपमेंट कोड',
      'cloud.devHint': 'डेवलपमेंट मोड: कोड सर्वर कंसोल में दिखाया जाता है।',
      'cloud.codeSent': 'कोड भेज दिया गया। यह कुछ मिनट में बेकार हो जाएगा।',
      'cloud.invalidCode': 'SMS में आए 6 अंकों का कोड लिखें।',
      'cloud.signedIn': 'साइन इन हो गया।',
      'cloud.signInTitle': 'अपने फ़ोन नंबर से साइन इन करें',
      'cloud.signInHint': 'इस नंबर की पुष्टि के लिए हम एक बार वाला कोड SMS से भेजते हैं। परिवार से जुड़ने पर दूसरे व्यक्ति की मंज़ूरी ज़रूरी है।',
      'cloud.noName': 'अभी कोई नाम सेट नहीं है',
      'cloud.signOut': 'साइन आउट',
      'cloud.signedOut': 'साइन आउट हो गया।',
      'cloud.displayName': 'आपका नाम (परिवार को दिखेगा)',
      'cloud.saveName': 'नाम सहेजें',
      'cloud.nameSaved': 'नाम सहेज दिया गया।',
      'cloud.familyTitle': 'परिवार मंडल',
      'cloud.familyHint': 'नंबर जोड़ने पर निमंत्रण जाता है। उन्हें साइन इन करके मंज़ूरी देनी होगी, तभी कोई लोकेशन या अलर्ट उन तक पहुँचेगा।',
      'cloud.invitePhone': 'परिवार के सदस्य का फ़ोन नंबर',
      'cloud.inviteName': 'उनका नाम (ज़रूरी नहीं)',
      'cloud.invite': 'निमंत्रण भेजें',
      'cloud.alreadyFamily': 'अब आप जुड़ चुके हैं।',
      'cloud.inviteSent': 'निमंत्रण भेज दिया गया। जब तक वे मंज़ूरी नहीं देंगे, यह लंबित रहेगा।',
      'cloud.pending': 'मंज़ूरी बाकी',
      'cloud.accepted': 'जुड़ा हुआ',
      'cloud.declined': 'मना किया',
      'cloud.revoked': 'हटाया गया',
      'cloud.consentTitle': 'जुड़े हुए परिवार के सदस्य',
      'cloud.noFamily': 'अभी परिवार का कोई सदस्य नहीं जुड़ा। ऊपर से किसी को निमंत्रण भेजें।',
      'cloud.unnamed': 'बिना नाम का संपर्क',
      'cloud.locationConsent': 'लोकेशन शेयरिंग चालू',
      'cloud.approve': 'मंज़ूरी दें',
      'cloud.approved': 'कनेक्शन की मंज़ूरी हो गई।',
      'cloud.remove': 'हटाएँ',
      'cloud.removed': 'हटा दिया गया।',
      'cloud.incomingTitle': 'आपकी मंज़ूरी का इंतज़ार',
      'cloud.wantsToConnect': 'परिवार के रूप में जुड़ना चाहते हैं',
      'cloud.decline': 'मना करें',
      'cloud.declinedNote': 'मना कर दिया गया।',
      'cloud.ocrTitle': 'स्क्रीनशॉट पढ़ें',
      'cloud.ocrHint': 'टेक्स्ट की पहचान इसी फ़ोन पर होती है। तस्वीर यहीं प्रोसेस होती है, कभी अपलोड नहीं होती।',
      'cloud.ocrPlaceholder': 'पढ़ा गया टेक्स्ट यहाँ दिखेगा और जाँचने के लिए भेजा जाएगा।',
      'cloud.ocrDone': 'टेक्स्ट इसी फ़ोन पर निकाल लिया गया।',
      'cloud.ocrEmpty': 'उस तस्वीर में पढ़ने लायक टेक्स्ट नहीं मिला।',
      'cloud.chooseScreenshot': 'स्क्रीनशॉट चुनें',
      'cloud.ocrUnsupported': 'यह फ़ोन उस तस्वीर को नहीं पढ़ सका। आप टेक्स्ट हाथ से चिपका सकते हैं।',
      'cloud.ocrPath': 'तस्वीर का पूरा पाथ',
      'cloud.extract': 'टेक्स्ट निकालें',
      'cloud.ocrPathRequired': 'इस फ़ोन में मौजूद स्क्रीनशॉट का पूरा पाथ लिखें।',
      'cloud.ocrToChecker': 'जाँच में इस्तेमाल करें',
      'cloud.sessionExpired': 'आपका सत्र समाप्त हो गया। फिर से साइन इन करें।',
      'cloud.forbidden': 'आपको यह करने की अनुमति नहीं है।',
      'cloud.notFound': 'वह चीज़ अब मौजूद नहीं है।',
      'cloud.alreadyRequested': 'इस नंबर के साथ पहले से एक अनुरोध लंबित है।',
      'cloud.alreadyConnected': 'आप इस व्यक्ति से पहले से जुड़े हुए हैं।',
      'cloud.notOptedIn': 'पहले अपने अलर्ट में पास के सहायक की ड्यूटी चालू करें।',
      'cloud.stateConflict': 'इमरजेंसी की स्थिति बदल गई। रीफ़्रेश करके फिर कोशिश करें।',
      'cloud.noSmsProvider': 'सर्वर पर SMS भेजने की सेटिंग अभी नहीं है।',
      'cloud.deliveryFailed': 'कोड नहीं पहुँच सका। थोड़ी देर में फिर कोशिश करें।',
      'cloud.requestFirst': 'पहले कोड मँगवाएँ।',
      'cloud.nameInvalid': '1 से 60 अक्षरों का नाम लिखें।',
      'cloud.requestSent': 'अनुरोध भेज दिया गया। उनकी मंज़ूरी तक यह लंबित रहेगा।',
      'cloud.cancelled': 'रद्द किया गया',
      'cloud.connected': 'जुड़ा हुआ',
      'cloud.removedState': 'हटाया गया',
      'cloud.since': 'जुड़ाव की तारीख',
      'cloud.alertsOn': 'आपके इमरजेंसी अलर्ट पाते हैं',
      'cloud.invitedYou': 'ने आपको अपने परिवार मंडल में आमंत्रित किया',
      'cloud.outgoingTitle': 'आपके भेजे गए',
      'cloud.awaitingSignup': 'उनके साइन इन करने की प्रतीक्षा',
      'cloud.awaitingApproval': 'उनकी मंज़ूरी की प्रतीक्षा',
      'cloud.prefsTitle': 'सहमतियाँ',
      'cloud.prefsHint': 'हर सहमति अलग है: अलर्ट का मतलब लोकेशन साझा करना या सहायक ड्यूटी कभी नहीं है।',
      'cloud.prefAlerts': 'इमरजेंसी में मेरे परिवार को अलर्ट करें',
      'cloud.prefLocation': 'इमरजेंसी उठाने पर मेरी लोकेशन साझा करें',
      'cloud.prefHelper': 'मुझे पास के सहायक के रूप में काम करने दें',
      'cloud.prefsSaved': 'सेटिंग सहेज दी गई।'
    },
    te: {
      'cloud.rateLimited': 'చాలాసార్లు ప్రయత్నించారు. కొంత సేపు ఆగి మళ్లీ ప్రయత్నించండి.',
      'cloud.unreachable': 'సర్వర్కు కనెక్ట్ కాలేదు. API చిరునామా మరియు మీ ఇంటర్నెట్ కనెక్షన్ తనిఖీ చేయండి.',
      'cloud.phone': 'ఫోన్ నంబర్',
      'cloud.code': '6 అంకెల కోడ్',
      'cloud.sendCode': 'కోడ్ పంపండి',
      'cloud.verify': 'ధృవీకరించండి',
      'cloud.invalidPhone': 'దేశ కోడ్తో నంబర్ నమోదు చేయండి, ఉదా. +919876543210.',
      'cloud.devCode': 'డెవలప్మెంట్ కోడ్',
      'cloud.devHint': 'డెవలప్మెంట్ మోడ్: కోడ్ సర్వర్ కన్సోల్లో చూపబడుతుంది.',
      'cloud.codeSent': 'కోడ్ పంపబడింది. అది కొద్ది నిమిషాల్లో గడువు ముగుస్తుంది.',
      'cloud.invalidCode': 'SMSలో వచ్చిన 6 అంకెల కోడ్ నమోదు చేయండి.',
      'cloud.signedIn': 'సైన్ ఇన్ అయింది.',
      'cloud.signInTitle': 'మీ ఫోన్ నంబర్తో సైన్ ఇన్ చేయండి',
      'cloud.signInHint': 'ఈ నంబర్ నిర్ధారణ కోసం మేము ఒకసారి వాడే కోడ్ను SMS ద్వారా పంపుతాము. కుటుంబ లింక్కు రెండో వ్యక్తి అనుమతి అవసరం.',
      'cloud.noName': 'ఇంకా పేరు సెట్ చేయలేదు',
      'cloud.signOut': 'సైన్ అవుట్',
      'cloud.signedOut': 'సైన్ అవుట్ అయింది.',
      'cloud.displayName': 'మీ పేరు (మీ కుటుంబానికి కనిపిస్తుంది)',
      'cloud.saveName': 'పేరు సేవ్ చేయండి',
      'cloud.nameSaved': 'పేరు సేవ్ అయింది.',
      'cloud.familyTitle': 'కుటుంబ వలయం',
      'cloud.familyHint': 'నంబర్ జోడిస్తే ఆహ్వానం పంపబడుతుంది. వారు సైన్ ఇన్ చేసి అనుమతి ఇచ్చిన తర్వాతే ఏ లొకేషన్ లేదా అలర్ట్ వారికి చేరుతుంది.',
      'cloud.invitePhone': 'కుటుంబ సభ్యుని ఫోన్ నంబర్',
      'cloud.inviteName': 'వారి పేరు (ఐచ్ఛికం)',
      'cloud.invite': 'ఆహ్వానం పంపండి',
      'cloud.alreadyFamily': 'ఇప్పుడు మీరు కనెక్ట్ అయ్యారు.',
      'cloud.inviteSent': 'ఆహ్వానం పంపబడింది. వారు అనుమతి ఇచ్చే వరకు ఇది పెండింగ్లో ఉంటుంది.',
      'cloud.pending': 'అనుమతి పెండింగ్',
      'cloud.accepted': 'కనెక్ట్ అయింది',
      'cloud.declined': 'తిరస్కరించారు',
      'cloud.revoked': 'తొలగించబడింది',
      'cloud.consentTitle': 'కనెక్ట్ అయిన కుటుంబ సభ్యులు',
      'cloud.noFamily': 'ఇంకా కుటుంబ సభ్యులు ఎవరూ లేరు. పైన ఉన్న ఫారమ్ ద్వారా ఎవరినైనా ఆహ్వానించండి.',
      'cloud.unnamed': 'పేరు లేని కాంటాక్ట్',
      'cloud.locationConsent': 'లొకేషన్ షేరింగ్ ఆన్లో ఉంది',
      'cloud.approve': 'అనుమతించండి',
      'cloud.approved': 'కనెక్షన్ అనుమతించబడింది.',
      'cloud.remove': 'తొలగించండి',
      'cloud.removed': 'తొలగించబడింది.',
      'cloud.incomingTitle': 'మీ అనుమతి కోసం ఎదురుచూపు',
      'cloud.wantsToConnect': 'కుటుంబంగా కనెక్ట్ కావాలని కోరుతున్నారు',
      'cloud.decline': 'తిరస్కరించండి',
      'cloud.declinedNote': 'తిరస్కరించబడింది.',
      'cloud.ocrTitle': 'స్క్రీన్షాట్ స్కాన్ చేయండి',
      'cloud.ocrHint': 'టెక్స్ట్ గుర్తింపు ఈ ఫోన్లోనే జరుగుతుంది. చిత్రం ఇక్కడే ప్రాసెస్ అవుతుంది, ఎప్పుడూ అప్లోడ్ కాదు.',
      'cloud.ocrPlaceholder': 'సేకరించిన టెక్స్ట్ ఇక్కడ కనిపిస్తుంది, తనిఖీ కోసం పంపబడుతుంది.',
      'cloud.ocrDone': 'టెక్స్ట్ ఈ ఫోన్లోనే సేకరించబడింది.',
      'cloud.ocrEmpty': 'ఆ చిత్రంలో చదవగలిగే టెక్స్ట్ కనిపించలేదు.',
      'cloud.chooseScreenshot': 'స్క్రీన్షాట్ ఎంచుకోండి',
      'cloud.ocrUnsupported': 'ఈ ఫోన్ ఆ చిత్రాన్ని చదవలేకపోయింది. మీరు టెక్స్ట్ను చేతితో పేస్ట్ చేయవచ్చు.',
      'cloud.ocrPath': 'చిత్రం పూర్తి పాత్',
      'cloud.extract': 'టెక్స్ట్ సేకరించండి',
      'cloud.ocrPathRequired': 'ఈ ఫోన్లో ఉన్న స్క్రీన్షాట్ పూర్తి పాత్ను నమోదు చేయండి.',
      'cloud.ocrToChecker': 'తనిఖీలో వాడండి',
      'cloud.sessionExpired': 'మీ సెషన్ గడువు ముగిసింది. మళ్లీ సైన్ ఇన్ చేయండి.',
      'cloud.forbidden': 'మీకు అది చేయడానికి అనుమతి లేదు.',
      'cloud.notFound': 'ఆ అంశం ఇప్పుడు లేదు.',
      'cloud.alreadyRequested': 'ఈ నంబర్తో ఇప్పటికే ఒక అభ్యర్థన పెండింగ్లో ఉంది.',
      'cloud.alreadyConnected': 'మీరు ఈ వ్యక్తితో ఇప్పటికే కనెక్ట్ అయ్యారు.',
      'cloud.notOptedIn': 'మొదట మీ హెచ్చరికల్లో సమీప సహాయకుడు విధిని ఆన్ చేయండి.',
      'cloud.stateConflict': 'అత్యవసర పరిస్థితి మారింది. రిఫ్రెష్ చేసి మళ్లీ ప్రయత్నించండి.',
      'cloud.noSmsProvider': 'సర్వర్లో SMS పంపే ఏర్పాటు ఇంకా లేదు.',
      'cloud.deliveryFailed': 'కోడ్ పంపలేకపోయాం. కొద్దిసేపటి తర్వాత మళ్లీ ప్రయత్నించండి.',
      'cloud.requestFirst': 'మొదట కోడ్ అభ్యర్థించండి.',
      'cloud.nameInvalid': '1 నుంచి 60 అక్షరాల పేరు నమోదు చేయండి.',
      'cloud.requestSent': 'అభ్యర్థన పంపబడింది. వారు అనుమతించే వరకు పెండింగ్లో ఉంటుంది.',
      'cloud.cancelled': 'రద్దు చేయబడింది',
      'cloud.connected': 'కనెక్ట్ అయ్యారు',
      'cloud.removedState': 'తొలగించబడింది',
      'cloud.since': 'కనెక్ట్ అయిన తేదీ',
      'cloud.alertsOn': 'మీ అత్యవసర హెచ్చరికలు అందుకుంటారు',
      'cloud.invitedYou': 'మిమ్మల్ని తమ కుటుంబ వలయానికి ఆహ్వానించారు',
      'cloud.outgoingTitle': 'మీరు పంపినవి',
      'cloud.awaitingSignup': 'వారు సైన్ ఇన్ చేయడానికి వేచి ఉంది',
      'cloud.awaitingApproval': 'వారి అనుమతి కోసం వేచి ఉంది',
      'cloud.prefsTitle': 'అనుమతులు',
      'cloud.prefsHint': 'ప్రతి అనుమతి వేర్వేరు: హెచ్చరికలు అంటే లొకేషన్ పంచుకోవడం లేదా సహాయకుడి విధి కాదు.',
      'cloud.prefAlerts': 'అత్యవసర సమయంలో నా కుటుంబానికి హెచ్చరిక పంపండి',
      'cloud.prefLocation': 'నేను అత్యవసరం లేవనెత్తినప్పుడు నా లొకేషన్ పంచుకోండి',
      'cloud.prefHelper': 'సమీప సహాయకుడిగా వ్యవహరించడానికి నన్ను అనుమతించండి',
      'cloud.prefsSaved': 'ప్రాధాన్యత సేవ్ అయింది.'
    }
  };

  // lang code -> the exact bucket object we already merged into, so repeat calls are
  // free and a pack swapped in later is picked up again.
  var mergedInto = {};

  function mergeSupplement() {
    var data = root.FS.i18nData;
    if (!data || typeof data !== 'object') return;

    for (var code in SUPPLEMENT) {
      if (!Object.prototype.hasOwnProperty.call(SUPPLEMENT, code)) continue;
      var dict = data[code];
      if (!dict || typeof dict !== 'object' || Array.isArray(dict)) continue;
      if (mergedInto[code] === dict) continue;

      var source = SUPPLEMENT[code];
      for (var key in source) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        // Pack value wins: only fill gaps, never overwrite a translated string.
        if (!Object.prototype.hasOwnProperty.call(dict, key)) dict[key] = source[key];
      }
      mergedInto[code] = dict;
    }
  }

  // A per-language empty bucket so lookups never blow up if a data file is missing.
  function ensureStrings() {
    var data = root.FS.i18nData;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      data = {};
      root.FS.i18nData = data;
    }
    for (var i = 0; i < LANGS.length; i++) {
      var code = LANGS[i].code;
      if (!data[code] || typeof data[code] !== 'object' || Array.isArray(data[code])) {
        data[code] = {};
      }
    }
    mergeSupplement();
    return data;
  }

  function codes() {
    var out = [];
    for (var i = 0; i < LANGS.length; i++) out.push(LANGS[i].code);
    return out;
  }

  function normalizeLang(lang) {
    if (typeof lang !== 'string') return null;
    var trimmed = lang.replace(/^\s+|\s+$/g, '');
    if (!trimmed) return null;
    var lower = trimmed.toLowerCase();
    // 'en-IN' -> 'en', 'zh-Hant' -> 'zh'
    var base = lower.split(/[-_]/)[0];
    var known = codes();
    for (var i = 0; i < known.length; i++) {
      if (known[i] === base) return known[i];
    }
    return null;
  }

  function interpolate(template, params) {
    if (typeof template !== 'string') return template;
    if (!params || typeof params !== 'object') return template;
    return template.replace(/\{([A-Za-z0-9_$.]+)\}/g, function (match, name) {
      if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
      var value = params[name];
      if (value === null || value === undefined) return match;
      return String(value);
    });
  }

  function rawLookup(lang, key) {
    var data = root.FS.i18nData;
    if (!data || typeof data !== 'object') return undefined;
    var dict = data[lang];
    if (!dict || typeof dict !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(dict, key)) return undefined;
    var value = dict[key];
    return typeof value === 'string' ? value : undefined;
  }

  // Only offer languages whose string pack actually shipped. Empty packs would
  // silently fall back to English, which reads as a broken translation.
  function available() {
    var data = root.FS.i18nData || {};
    var out = [];
    for (var i = 0; i < LANGS.length; i++) {
      var dict = data[LANGS[i].code];
      if (dict && typeof dict === 'object' && Object.keys(dict).length > 0) out.push(LANGS[i]);
    }
    return out.length ? out : LANGS.slice();
  }

  var i18n = {
    version: '1.0.0',
    defaultLang: DEFAULT_LANG,
    fallbackLang: FALLBACK_LANG,
    langs: LANGS,
    languages: available(),
    langsCodes: codes(),

    get strings() {
      return ensureStrings();
    },

    /**
     * True when `lang` defines `key` itself (does not consider the en fallback).
     */
    has: function (lang, key) {
      try {
        if (typeof key !== 'string' || !key) return false;
        var resolved = normalizeLang(lang);
        if (!resolved) return false;
        return rawLookup(resolved, key) !== undefined;
      } catch (err) {
        return false;
      }
    },

    /**
     * Translated string. Never throws. Unknown key -> the key itself.
     * Unknown/absent lang -> falls back to `en`, then to the key.
     */
    t: function (key, lang, params) {
      try {
        if (typeof key !== 'string' || !key) return typeof key === 'string' ? key : '';
        ensureStrings();
        var resolved = normalizeLang(lang) || DEFAULT_LANG;
        var value = rawLookup(resolved, key);
        if (value === undefined && resolved !== FALLBACK_LANG) {
          value = rawLookup(FALLBACK_LANG, key);
        }
        if (value === undefined) return key;
        return interpolate(value, params);
      } catch (err) {
        return typeof key === 'string' ? key : '';
      }
    },

    /**
     * Merge strings contributed by a later-loaded module.
     *
     * Modules that ship after i18n.js (sos.js, helper.js, …) call
     * `FS.i18n.addStrings({en:{...}, hi:{...}, te:{...}})` at load time so their
     * copy is translated without editing the core packs. Module values are
     * authoritative for the keys they define; everything else is untouched.
     */
    addStrings: function (map) {
      try {
        if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
        var data = ensureStrings();
        for (var code in map) {
          if (!Object.prototype.hasOwnProperty.call(map, code)) continue;
          var resolved = normalizeLang(code);
          if (!resolved) continue;
          if (!data[resolved] || typeof data[resolved] !== 'object') data[resolved] = {};
          var bucket = data[resolved];
          var source = map[code];
          if (!source || typeof source !== 'object') continue;
          for (var key in source) {
            if (Object.prototype.hasOwnProperty.call(source, key)) bucket[key] = source[key];
          }
        }
        return true;
      } catch (err) {
        return false;
      }
    },

    /**
     * Best-effort language detection from navigator.language(s). Never throws.
     */
    detect: function () {
      try {
        var nav = root.navigator;
        var candidates = [];
        if (nav) {
          if (typeof nav.language === 'string') candidates.push(nav.language);
          if (nav.languages && typeof nav.languages.length === 'number') {
            for (var i = 0; i < nav.languages.length; i++) candidates.push(nav.languages[i]);
          }
        }
        for (var j = 0; j < candidates.length; j++) {
          var match = normalizeLang(candidates[j]);
          if (match) return match;
        }
      } catch (err) {
        /* ignore — detection is best-effort */
      }
      return DEFAULT_LANG;
    },

    /**
     * Locale-aware number formatting. Best-effort: any failure returns String(n).
     */
    formatNumber: function (n, lang) {
      var value = typeof n === 'number' ? n : Number(n);
      if (!isFinite(value)) return typeof n === 'string' ? n : '';
      try {
        var resolved = normalizeLang(lang) || DEFAULT_LANG;
        if (typeof Intl !== 'undefined' && typeof Intl.NumberFormat === 'function') {
          return new Intl.NumberFormat(resolved).format(value);
        }
      } catch (err) {
        /* fall through */
      }
      try {
        return String(value);
      } catch (err2) {
        return '';
      }
    },

    /**
     * Assembly helper used by app.js. Returns a plain object of all strings for a language,
     * with `en` filling anything the language is missing. Never throws.
     */
    bundle: function (lang) {
      var resolved = normalizeLang(lang) || DEFAULT_LANG;
      var out = {};
      try {
        var en = root.FS.i18nData && root.FS.i18nData[DEFAULT_LANG];
        if (en && typeof en === 'object') {
          for (var k in en) if (Object.prototype.hasOwnProperty.call(en, k)) out[k] = en[k];
        }
        var dict = root.FS.i18nData && root.FS.i18nData[resolved];
        if (dict && typeof dict === 'object' && resolved !== DEFAULT_LANG) {
          for (var k2 in dict) if (Object.prototype.hasOwnProperty.call(dict, k2)) out[k2] = dict[k2];
        }
      } catch (err) {
        /* return what we have */
      }
      return out;
    },

    /**
     * Keys defined by a language / by en / missing per language. Used by the test runner
     * and by the parity check, never by app.js at runtime.
     */
    audit: function () {
      var data = ensureStrings();
      var report = { langs: {}, enCount: 0, missing: {} };
      var enKeys = [];
      for (var k in data[DEFAULT_LANG]) {
        if (Object.prototype.hasOwnProperty.call(data[DEFAULT_LANG], k)) enKeys.push(k);
      }
      report.enCount = enKeys.length;
      for (var i = 0; i < LANGS.length; i++) {
        var code = LANGS[i].code;
        var dict = data[code];
        var count = 0;
        var missing = [];
        for (var k2 in dict) {
          if (Object.prototype.hasOwnProperty.call(dict, k2)) count++;
        }
        for (var j = 0; j < enKeys.length; j++) {
          if (rawLookup(code, enKeys[j]) === undefined) missing.push(enKeys[j]);
        }
        report.langs[code] = { count: count, missing: missing.length };
        report.missing[code] = missing;
      }
      return report;
    }
  };

  ensureStrings();
  root.FS.i18n = i18n;
})();
