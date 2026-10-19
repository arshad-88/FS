/*
 * FamilyShield — offline analysis engine.
 * Contract: docs/CONTRACTS.md §2.
 *
 * Pure, synchronous, deterministic. No DOM, no network, no storage, no Date, no random.
 * Classic script: exposes window.FS.engine = { analyze, version }.
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  root.FS = root.FS || {};

  var ENGINE_VERSION = '1.0.0';
  var MAX_INPUT = 8000;
  var MAX_URLS = 12;

  var ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff\u00ad]/g;
  var HOMOGLYPH = /[\u0400-\u04ff\u0370-\u03ff]/;
  var EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu;

  var FALLBACK_GUIDANCE = [
    'guidance.calmDown',
    'guidance.verifyIndependently',
    'guidance.talkToFamily'
  ];

  // ---------------------------------------------------------------- lexicons

  var T = {
    urgency: [
      'urgent', 'urgently', 'immediately', 'right now', 'within 24 hours', 'within 24 hrs',
      'within 2 hours', 'last chance', 'final warning', 'expires today', 'expiring today',
      'act now', 'hurry', 'before it is too late', 'before it\'s too late', 'today itself',
      'तुरंत', 'जल्दी', 'आज ही', 'अभी', 'अंतिम चेतावनी', 'உடனே', 'இன்றே', 'వెంటనే', 'இன்று',
      'తక్షణమే', 'এখনই', 'দ্রুত', 'আজই'
    ],
    threat: [
      'your account will be blocked', 'account will be suspended', 'account will be closed',
      'service will be disconnected', 'connection will be disconnected', 'sim will be blocked',
      'sim will be deactivated', 'legal action', 'court case', 'arrest', 'fir will be filed',
      'penalty', 'fine of', 'you will lose', 'permanently blocked', 'account freeze',
      'खाता बंद', 'सिम बंद', 'कानूनी कार्रवाई', 'गिरफ्तार', 'जुर्माना', 'बिजली काट',
      'கணக்கு முடக்க', 'சட்ட நடவடிக்கை', 'கைது', 'ఖాతా బ్లాక్', 'చట్టపరమైన చర్య', 'అరెస్టు',
      'অ্যাকাউন্ট ব্লক', 'আইনি ব্যবস্থা', 'গ্রেপ্তার', 'বিল সংযোগ বিচ্ছিন্ন'
    ],
    legalThreat: [
      'legal notice', 'court notice', 'police complaint', 'cyber cell case', 'money laundering',
      'fir', 'non-bailable', 'summons', 'supreme court', 'high court', 'trai notice',
      'कानूनी नोटिस', 'कोर्ट नोटिस', 'पुलिस शिकायत', 'मनी लॉन्ड्रिंग', 'एफआईआर', 'समन',
      'நீதிமன்ற அறிவிப்பு', 'போலீஸ் புகார்', 'சட்ட அறிவிப்பு', 'కోర్టు నోటీసు', 'పోలీస్ ఫిర్యాదు',
      'আদালতের নোটিশ', 'পুলিশ অভিযোগ', 'মানি লন্ডারিং'
    ],
    digitalArrest: [
      'digital arrest', 'digital arrest warrant', 'cbi officer', 'cbi investigation',
      'narcotics case', 'courier parcel contains drugs', 'parcel contains drugs',
      'join video call for verification', 'stay on the video call', 'do not tell anyone about this case',
      'डिजिटल अरेस्ट', 'सीबीआई अधिकारी', 'सीबीआई जांच', 'नशीला पदार्थ', 'वीडियो कॉल पर रहें',
      'डिजिटल गिरफ्तारी', 'டிஜிட்டல் கைது', 'சிபிஐ அதிகாரி', 'డిజిటల్ అరెస్ట్', 'సీబీఐ అధికారి',
      'ডিজিটাল অ্যারেস্ট', 'সিবিআই অফিসার'
    ],
    otp: [
      'otp', 'one time password', 'verification code', 'login code', 'ओटीपी', 'ओ.टी.पी',
      'ओटीपी कोड', 'ஒடிபி', 'ఓటీపీ', 'ওটিপি'
    ],
    share: [
      'share', 'send', 'tell', 'forward', 'reply with', 'provide', 'give me', 'confirm',
      'बताएं', 'बताइए', 'भेजें', 'भेज दें', 'शेयर', 'साझा', 'बता दो', 'भेजो',
      'பகிர்', 'அனுப்பு', 'சொல்', 'పంపండి', 'చెప్పండి', 'షేర్', 'শেয়ার', 'পাঠান', 'বলুন'
    ],
    credential: [
      'cvv', 'card number', 'debit card', 'credit card', 'net banking password', 'netbanking password',
      'internet banking password', 'pin number', 'atm pin', 'upi pin', 'mpin', 'aadhaar number',
      'aadhar number', 'pan number', 'password', 'login id and password', 'account number and ifsc',
      'bank details', 'cvv number', 'सीवीवी', 'कार्ड नंबर', 'एटीएम पिन', 'यूपीआई पिन',
      'पासवर्ड', 'आधार नंबर', 'बैंक विवरण', 'சிவிவி', 'கார்டு எண்', 'கடவுச்சொல்', 'ஆதார் எண்',
      'సీవీవీ', 'కార్డు నంబర్', 'పాస్వర్డ్', 'ఆధార్ నంబర్', 'সিভিভি', 'কার্ড নম্বর', 'পাসওয়ার্ড'
    ],
    moneyBait: [
      'you have won', 'you won', 'congratulations', 'lottery', 'lucky winner', 'prize money',
      'cash reward', 'gift voucher', 'free gift', 'scratch card', 'jackpot', 'refund of',
      'cashback of', 'आपने जीता', 'बधाई हो', 'लॉटरी', 'इनाम', 'नकद पुरस्कार', 'मुफ्त उपहार',
      'பரிசு', 'லாட்டரி', 'வாழ்த்துக்கள்', 'బహుమతి', 'లాటరీ', 'అభినందనలు', 'পুরস্কার', 'লটারি', 'অভিনন্দন'
    ],
    jobBait: [
      'work from home', 'part time job', 'part-time job', 'typing job', 'data entry job',
      'earn daily', 'earn 500', 'earn 1000', 'earn 2000', 'daily income', 'easy money',
      'no experience required', 'online job', 'telegram task', 'like and earn', 'youtube task',
      'घर से काम', 'पार्ट टाइम नौकरी', 'रोज कमाएं', 'डेली इनकम', 'टाइपिंग जॉब', 'ऑनलाइन जॉब',
      'வீட்டில் வேலை', 'பகுதி நேர வேலை', 'தினமும் சம்பாதிக்க', 'ఇంటి నుండి పని', 'పార్ట్ టైమ్ ఉద్యోగం',
      'রোজগার', 'বাড়ি থেকে কাজ', 'পার্ট টাইম চাকরি'
    ],
    loanBait: [
      'pre-approved loan', 'pre approved loan', 'instant loan', 'loan approved', 'loan sanction',
      'no documents required', 'without cibil', 'zero interest loan', 'personal loan approved',
      'तुरंत लोन', 'लोन मंजूर', 'बिना दस्तावेज', 'प्री-अप्रूव्ड लोन', 'உடனடி கடன்', 'கடன் அனுமதி',
      'తక్షణ రుణం', 'రుణం ఆమోదం', 'তাৎক্ষণিক ঋণ', 'ঋণ অনুমোদিত'
    ],
    kycBait: [
      'kyc', 'k.y.c', 'complete your kyc', 'update your kyc', 'kyc update', 'kyc expired',
      'kyc pending', 're-kyc', 'video kyc', 'आधार कार्ड अपडेट', 'केवाईसी', 'केवाईसी अपडेट',
      'केवाईसी बंद', 'கேவைசி', 'కేవైసీ', 'কেওয়াইসি'
    ],
    impersonation: [
      'bank', 'hdfc', 'sbi', 'state bank of india', 'icici', 'axis bank', 'kotak', 'paytm',
      'phonepe', 'google pay', 'gpay', 'amazon', 'flipkart', 'myntra', 'swiggy', 'zomato',
      'irctc', 'india post', 'delhivery', 'bluedart', 'dtdc', 'fedex', 'dhl', 'lic',
      'income tax department', 'epfo', 'uidai', 'trai', 'rbi', 'reserve bank of india',
      'electricity board', 'bsnl', 'jio', 'airtel', 'vi customer care', 'customs',
      'बैंक', 'एचडीएफसी', 'एसबीआई', 'आईसीआईसीआई', 'अमेज़न', 'फ्लिपकार्ट', 'आयकर विभाग',
      'बिजली विभाग', 'कस्टम्स', 'वीआईपी', 'வங்கி', 'அமேசான்', 'வருமான வரித்துறை', 'மின்சார வாரியம்',
      'బ్యాంక్', 'అమెజాన్', 'ఆదాయపు పన్ను శాఖ', 'విద్యుత్ బోర్డు', 'ব্যাংক', 'অ্যামাজন', 'আয়কর দপ্তর'
    ],
    remoteAccess: [
      'anydesk', 'quick support', 'quicksupport', 'teamviewer', 'rustdesk', 'team viewer',
      'screen sharing', 'share your screen', 'screen share', 'remote access app', 'install this app to help',
      'install the app and share', 'एनीडेस्क', 'क्विक सपोर्ट', 'स्क्रीन शेयर', 'स्क्रीन साझा',
      'ரிமோட்', 'திரையை பகிர்', 'స్క్రీన్ షేర్', 'రిమోట్ యాక్సెస్', 'স্ক্রিন শেয়ার', 'রিমোট'
    ],
    refundDelivery: [
      'refund is pending', 'refund pending', 'refund failed', 'failed delivery', 'delivery failed',
      'parcel is stuck', 'parcel held at customs', 'customs clearance fee', 'reschedule delivery fee',
      'pay delivery charge', 're-delivery fee', 'order cancelled refund', 'refund request',
      'पार्सल रुका', 'डिलीवरी फेल', 'कस्टम शुल्क', 'रिफंड', 'பார்சல் நிறுத்தம்', 'டெலிவரி தோல்வி',
      'పార్సెల్ ఆగిపోయింది', 'డెలివరీ విఫలమైంది', 'পার্সেল আটকে', 'ডেলিভারি ব্যর্থ'
    ],
    investment: [
      'guaranteed return', 'guaranteed profit', 'double your money', 'double your investment',
      'crypto investment', 'bitcoin profit', 'trading tips', 'sure shot', 'risk free investment',
      'monthly returns', 'nifty tips', 'stock tips group', 'निश्चित मुनाफा', 'पैसा दोगुना',
      'गारंटीड रिटर्न', 'கிரிப்டோ', 'లాభం గ్యారంటీ', 'ক্রিপ্টো', 'গ্যারান্টিযুক্ত মুনাফা'
    ],
    familyEmergency: [
      'your son is in trouble', 'your daughter is in trouble', 'your child is injured',
      'accident case', 'hospital deposit', 'operation needs money', 'kidnapped', 'kidnap',
      'your son is arrested', 'your daughter is arrested', 'बेटा अस्पताल', 'बेटी अस्पताल',
      'दुर्घटना', 'अपहरण', 'बेटा गिरफ्तार', 'मेरा बेटा', 'मेरी बेटी', 'மகன் விபத்து', 'மகள் மருத்துவமனை',
      'కొడుకు ప్రమాదం', 'కూతురు ఆసుపత్రి', 'ছেলে দুর্ঘটনা', 'মেয়ে হাসপাতাল'
    ],
    parcelCustoms: [
      'parcel', 'courier', 'consignment', 'customs', 'customs duty', 'drugs found',
      'illegal items found', 'parcel returned', 'पार्सल', 'कूरियर', 'सामान जब्त', 'सीमा शुल्क',
      'பார்சல்', 'கூரியர்', 'సరుకు', 'కూరియర్', 'পার্সেল', 'কুরিয়ার'
    ],
    electricity: [
      'disconnection notice', 'bill not paid', 'electricity will be disconnected',
      'power will be disconnected', 'बिजली काट दी जाएगी', 'बिजली बंद कर दी जाएगी',
      'बिजली बिल नहीं भरा', 'மின்சார இணைப்பு துண்டிக்க', 'విద్యుత్ కనెక్షన్ కట్',
      'বিদ্যুৎ সংযোগ বিচ্ছিন্ন'
    ],
    sim: [
      'sim card', 'sim will be deactivated', 'sim deactivation', 'sim blocked', 'sim verification',
      'mobile number will be blocked', 'sim कार्ड', 'सिम बंद', 'सिम ब्लॉक', 'சிம் முடக்கம்',
      'సిమ్ బ్లాక్', 'সিম ব্লক'
    ],
    secrecy: [
      'do not tell anyone', 'don\'t tell anyone', 'keep this secret', 'do not inform anyone',
      'do not discuss', 'between you and me', 'stay on the call', 'do not disconnect the call',
      'किसी को न बताएं', 'किसी को मत बताइए', 'गुप्त रखें', 'कॉल मत काटिए', 'யாரிடமும் சொல்ல வேண்டாம்',
      'காலை துண்டிக்க வேண்டாம்', 'ఎవరికీ చెప్పవద్దు', 'కాల్ కట్ చేయవద్దు', 'কাউকে বলবেন না', 'কল কাটবেন না'
    ],
    genericGreeting: [
      'dear customer', 'dear user', 'dear sir/madam', 'dear customer,', 'dear member',
      'dear account holder', 'dear applicant', 'dear beneficiary', 'प्रिय ग्राहक', 'प्रिय उपयोगकर्ता',
      'प्रिय सदस्य', 'பிரிய வாடிக்கையாளரே', 'பிரிய பயனரே', 'ప్రియమైన కస్టమర్', 'ప్రియమైన వినియోగదారు',
      'প্রিয় গ্রাহক', 'প্রিয় ব্যবহারকারী'
    ],
    transactional: [
      'debited', 'credited', 'available balance', 'available bal', 'a/c no', 'a/c xx', 'ac xx',
      'transaction id', 'txn id', 'ref no', 'not you', 'not done by you', 'जमा', 'निकासी',
      'शेष राशि', 'लेनदेन', 'வரவு', 'பற்று', 'இருப்பு', 'జమా', 'డెబిట్', 'నిల్వ', 'জমা', 'ব্যালেন্স'
    ],
    protectiveNoShare: [
      'do not share', 'don\'t share', 'never share', 'do not disclose', 'never disclose',
      'do not reveal', 'we never ask', 'bank never asks', 'no one should ask',
      'किसी के साथ साझा न करें', 'साझा न करें', 'कभी साझा न करें', 'भेजें नहीं', 'பகிர வேண்டாம்',
      'பங்கிட வேண்டாம்', 'పంచుకోవద్దు', 'షేర్ చేయవద్దు', 'শেয়ার করবেন না', 'কারও সাথে শেয়ার করবেন না'
    ],
    collect: [
      'collect request', 'collect money request', 'approve collect', 'approve the request',
      'payment request', 'requested money', 'sent you a request', 'accept request to receive',
      'कलेक्ट रिक्वेस्ट', 'भुगतान अनुरोध', 'पैसे का अनुरोध', 'கலெக்ட் ரிக்வெஸ்ட்', 'பணம் கேட்கப்பட்டது',
      'కలెక్ట్ రిక్వెస్ట్', 'డబ్బు అభ్యర్థన', 'কালেক্ট রিকোয়েস্ট', 'টাকার অনুরোধ'
    ],
    receiveMisconception: [
      'approve to receive', 'accept to receive', 'enter pin to receive', 'pin to receive money',
      'receive money by entering', 'to receive money enter', 'पैसे पाने के लिए पिन', 'पिन डालकर पैसे लें',
      'பெற பின்', 'பணம் பெற', 'డబ్బు పొందడానికి పిన్', 'টাকা পেতে পিন'
    ],
    upiPinRequest: [
      'upi pin', 'upi पिन', 'यूपीआई पिन', 'mpin', 'pin number', 'enter your pin', 'share your pin',
      'பின் எண்', 'பిన్', 'పిన్ నంబర్', 'পিন নম্বর', 'यूपीआई पिन डालें'
    ],
    sendMoneyUrgent: [
      'send money now', 'transfer immediately', 'transfer the amount', 'pay now to avoid',
      'pay the fee', 'pay processing fee', 'send rs', 'transfer rs', 'send money to this account',
      'तुरंत भेजें', 'पैसे भेजें', 'राशि भेजें', 'शुल्क जमा करें', 'பணம் அனுப்பு', 'கட்டணம் செலுத்து',
      'డబ్బు పంపండి', 'ఫీజు చెల్లించండి', 'টাকা পাঠান', 'ফি দিন'
    ],
    feeUpfront: [
      'processing fee', 'registration fee', 'security deposit', 'advance payment', 'pay first',
      'small fee', 'release fee', 'clearance charge', 'delivery charge', 'service charge',
      'प्रोसेसिंग फीस', 'रजिस्ट्रेशन फीस', 'सिक्योरिटी डिपॉजिट', 'पहले भुगतान', 'छोटा शुल्क',
      'செயலாக்க கட்டணம்', 'ముందస్తు చెల్లింపు', 'প্রসেসিং ফি', 'আগাম পেমেন্ট'
    ],
    qrToReceive: [
      'scan this qr', 'scan qr to receive', 'qr code to receive money', 'scan the qr code',
      'क्यूआर स्कैन', 'पैसे पाने के लिए क्यूआर', 'க்யூஆர்', 'QR స్కాన్', 'কিউআর স্ক্যান'
    ],
    tooGood: [
      '100% free', 'absolutely free', 'guaranteed', 'no risk', 'limited offer', 'exclusive offer',
      'only today', 'free of cost', 'बिल्कुल मुफ्त', 'गारंटी', 'सीमित ऑफर', 'இலவசம்', 'உத்தரவாதம்',
      'ఉచితం', 'గ్యారంటీ', 'বিনামূল্যে', 'গ্যারান্টি'
    ],
    authority: [
      'government approved', 'rbi approved', 'sebi registered', 'official partner',
      'authorised by', 'as per government order', 'सरकार द्वारा अनुमोदित', 'आरबीआई अनुमोदित',
      'அரசு அங்கீகாரம்', 'ప్రభుత్వ ఆమోదం', 'সরকার অনুমোদিত'
    ],
    fear: [
      'you are in trouble', 'you will be arrested', 'your family will be harmed',
      'we will file a case', 'your number will be blacklisted', 'आप गिरफ्तार होंगे',
      'केस दर्ज होगा', 'परिवार को नुकसान', 'நீங்கள் கைது', 'మీరు అరెస్ట్', 'আপনি গ্রেপ্তার হবেন'
    ],
    flattery: [
      'you are selected', 'you are lucky', 'congratulations you have been selected',
      'you are the winner', 'आप चुने गए हैं', 'आप भाग्यशाली हैं', 'நீங்கள் தேர்ந்தெடுக்கப்பட்டீர்கள்',
      'మీరు ఎంపికయ్యారు', 'আপনি নির্বাচিত হয়েছেন'
    ]
  };

  var BRANDS = {
    'hdfc': ['hdfcbank.com', 'hdfc.com'],
    'sbi': ['onlinesbi.sbi', 'sbi.co.in', 'onlinesbi.com', 'sbicard.com'],
    'icici': ['icicibank.com'],
    'axis': ['axisbank.com'],
    'kotak': ['kotak.com', 'kotakbank.com'],
    'paytm': ['paytm.com'],
    'phonepe': ['phonepe.com'],
    'gpay': ['pay.google.com'],
    'amazon': ['amazon.in', 'amazon.com'],
    'flipkart': ['flipkart.com'],
    'irctc': ['irctc.co.in', 'irctc.com'],
    'indiapost': ['indiapost.gov.in'],
    'lic': ['licindia.in'],
    'epfo': ['epfindia.gov.in'],
    'uidai': ['uidai.gov.in'],
    'incometax': ['incometax.gov.in', 'incometaxindia.gov.in'],
    'rbi': ['rbi.org.in'],
    'trai': ['trai.gov.in'],
    'delhivery': ['delhivery.com'],
    'bluedart': ['bluedart.com'],
    'dtdc': ['dtdc.in', 'dtdc.com'],
    'myntra': ['myntra.com'],
    'swiggy': ['swiggy.com'],
    'zomato': ['zomato.com'],
    'jio': ['jio.com'],
    'airtel': ['airtel.in'],
    'bsnl': ['bsnl.co.in'],
    'netflix': ['netflix.com'],
    'whatsapp': ['whatsapp.com', 'wa.me']
  };

  var SHORTENERS = [
    'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'cutt.ly', 'rb.gy',
    'shorturl.at', 'tiny.cc', 'rebrand.ly', 'bit.do', 's.id', 'lnkd.in', 'shorte.st',
    'adf.ly', 'bl.ink', 't.ly', 'clck.ru', 'v.gd', 'tiny.one', 'urlz.fr', 'rb.link'
  ];

  var RISKY_TLDS = [
    'zip', 'mov', 'top', 'xyz', 'click', 'link', 'live', 'shop', 'online', 'site', 'icu',
    'buzz', 'rest', 'fit', 'cam', 'monster', 'quest', 'cyou', 'sbs', 'cfd', 'lat', 'ltd',
    'vip', 'win', 'loan', 'work', 'men', 'review', 'country', 'stream', 'download', 'racing',
    'accountant', 'date', 'faith', 'party', 'science', 'gdn', 'bid', 'trade', 'webcam'
  ];

  var ACTION_WORDS = [
    'login', 'log-in', 'signin', 'sign-in', 'verify', 'verification', 'kyc', 'otp', 'update',
    'unblock', 'refund', 'claim', 'reward', 'wallet', 'secure', 'account', 'banking', 'payment',
    'pay', 'approve', 'collect', 'recover', 'reactivate', 'validate', 'confirm'
  ];

  // ---------------------------------------------------------------- helpers

  function stripUrlsForText(value) {
    return value.replace(/(?:https?:\/\/|www\.)[^\s<>"'`]+/gi, ' ');
  }

  function compact(value) {
    return String(value)
      .replace(/[^0-9a-z\u0900-\u097f\u0980-\u09ff\u0b80-\u0bff\u0c00-\u0c7f\u0d00-\u0d7f@.+:/_-]+/gi, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^ | $/g, '');
  }

  var PHRASE_RE = {};

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function phraseMatcher(phrase) {
    if (PHRASE_RE[phrase]) return PHRASE_RE[phrase];
    var asciiPlain = /^[a-z0-9 ]+$/i.test(phrase);
    var matcher = asciiPlain
      ? new RegExp('(?:^|[^a-z0-9])' + escapeRegExp(phrase) + '(?:[^a-z0-9]|$)', 'i')
      : null;
    PHRASE_RE[phrase] = matcher;
    return matcher;
  }

  function hasPhrase(haystack, phrases) {
    for (var i = 0; i < phrases.length; i++) {
      var phrase = phrases[i];
      var matcher = phraseMatcher(phrase);
      if (matcher ? matcher.test(haystack) : haystack.indexOf(phrase) !== -1) return phrase;
    }
    return null;
  }

  function countMatches(value, regex, cap) {
    var m = value.match(regex);
    if (!m) return 0;
    return typeof cap === 'number' && m.length > cap ? cap : m.length;
  }

  function truncate(value, max) {
    var s = String(value == null ? '' : value);
    s = s.replace(/\s+/g, ' ').replace(/^ | $/g, '');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = [];
    var i;
    var j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      var curr = [i];
      for (j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      prev = curr;
    }
    return prev[b.length];
  }

  function normalizeLeet(value) {
    return String(value)
      .replace(/0/g, 'o')
      .replace(/1/g, 'l')
      .replace(/3/g, 'e')
      .replace(/4/g, 'a')
      .replace(/5/g, 's')
      .replace(/7/g, 't')
      .replace(/8/g, 'b');
  }

  function registrableDomain(host) {
    var labels = host.split('.').filter(Boolean);
    if (labels.length <= 2) return labels.join('.');
    var twoLevel = ['co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'nic', 'firm', 'gen', 'ind'];
    var last = labels[labels.length - 1];
    var secondLast = labels[labels.length - 2];
    if (last.length === 2 && twoLevel.indexOf(secondLast) !== -1) {
      return labels.slice(-3).join('.');
    }
    return labels.slice(-2).join('.');
  }

  function extractUrls(text) {
    var found = [];
    var seen = {};
    var reHttp = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
    var match;
    while ((match = reHttp.exec(text)) !== null) {
      var value = match[0].replace(/[.,;:!?)\]}'"»]+$/g, '');
      if (value && !seen[value]) {
        seen[value] = true;
        found.push(value);
      }
    }
    var reBare = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|in|co|org|net|info|biz|io|me|app|xyz|top|shop|site|online|link|click|live|icu|buzz|sbs|cfd|vip|win|loan|work|club|store|tech|pro|in\.net)\b(?:\/[^\s<>"'`]*)?/gi;
    while ((match = reBare.exec(text)) !== null) {
      var bare = match[0].replace(/[.,;:!?)\]}'"»]+$/g, '');
      var at = match.index > 0 ? text.charAt(match.index - 1) : '';
      if (at === '@') continue;
      if (bare.indexOf('@') !== -1) continue;
      if (!seen[bare]) {
        seen[bare] = true;
        found.push(bare);
      }
    }
    return found.slice(0, MAX_URLS);
  }

  function parseHost(rawUrl) {
    var url = String(rawUrl).replace(/^ /, '');
    var hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
    var afterScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    var authority = afterScheme.split(/[/?#]/)[0];
    var atSign = authority.indexOf('@') !== -1;
    if (atSign) authority = authority.slice(authority.lastIndexOf('@') + 1);
    var port = '';
    var portMatch = authority.match(/:(\d{1,5})$/);
    if (portMatch) {
      port = portMatch[1];
      authority = authority.slice(0, -portMatch[0].length);
    }
    var host = authority.toLowerCase().replace(/\.$/, '');
    var scheme = (url.match(/^([a-z][a-z0-9+.-]*):\/\//i) || [])[1];
    var pathQuery = afterScheme.split(/[/?#]/).length > 1 ? afterScheme.slice(authority.length) : '';
    return {
      raw: rawUrl,
      hadScheme: hadScheme,
      scheme: scheme ? scheme.toLowerCase() : '',
      host: host,
      port: port,
      atSign: atSign,
      pathQuery: pathQuery,
      path: pathQuery.split('?')[0],
      query: pathQuery.indexOf('?') !== -1 ? pathQuery.slice(pathQuery.indexOf('?') + 1) : ''
    };
  }

  function isIpv4(host) {
    return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split('.').every(function (part) {
      var n = Number(part);
      return n >= 0 && n <= 255;
    });
  }

  function isOfficial(host, brand) {
    var domains = BRANDS[brand] || [];
    for (var i = 0; i < domains.length; i++) {
      var d = domains[i];
      if (host === d || host.slice(-(d.length + 1)) === '.' + d) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- analysis

  function analyze(input, options) {
    var rawInput = typeof input === 'string' ? input : (input == null ? '' : String(input));
    var lang = options && typeof options.lang === 'string' ? options.lang : 'en';
    var inputTruncated = rawInput.length > MAX_INPUT;
    var raw = rawInput.slice(0, MAX_INPUT);

    var hasZeroWidth = raw.search(ZERO_WIDTH) !== -1;
    var unicode = raw;
    try {
      if (typeof raw.normalize === 'function') unicode = raw.normalize('NFKC');
    } catch (err) { /* keep raw */ }

    var lower = unicode.toLowerCase();
    var scan = compact(lower);
    var textWithoutUrls = stripUrlsForText(lower);
    var scanWithoutUrls = compact(textWithoutUrls);
    var urls = extractUrls(unicode);

    var entries = [];
    var seen = {};
    var families = {};

    function add(id, family, weight, evidence, params, query) {
      if (seen[id]) return;
      seen[id] = true;
      families[family] = true;
      entries.push({
        id: id,
        family: family,
        weight: weight,
        evidence: truncate(evidence == null ? '' : evidence, 80),
        params: params && typeof params === 'object' ? params : {},
        query: typeof query === 'string' ? query : ''
      });
    }

    var occupied = {};

    function addFamily(group, family, weight, params) {
      var term = hasPhrase(scanWithoutUrls, T[group]);
      if (!term) return;
      add('content.' + family, 'content', weight, term, params);
      occupied[family] = true;
    }

    // --- product-side families
    addFamily('urgency', 'urgency', 8);
    addFamily('threat', 'threat', 14);
    addFamily('legalThreat', 'legalThreat', 18);
    addFamily('digitalArrest', 'digitalArrest', 30);
    addFamily('moneyBait', 'moneyBait', 10);
    addFamily('jobBait', 'jobBait', 14);
    addFamily('loanBait', 'loanBait', 14);
    addFamily('kycBait', 'kycBait', 16);
    addFamily('remoteAccess', 'remoteAccess', 30);
    addFamily('refundDelivery', 'refundDelivery', 8);
    addFamily('investment', 'investmentBait', 14, { skill: 'investment' });
    addFamily('familyEmergency', 'familyEmergency', 18);
    addFamily('parcelCustoms', 'parcelCustoms', 12);
    addFamily('electricity', 'electricityDisconnect', 12);
    addFamily('sim', 'simDeactivation', 12);

    // --- OTP request requires an OTP mention plus a share/send ask
    var otpTerm = hasPhrase(scanWithoutUrls, T.otp);
    var shareTerm = hasPhrase(scanWithoutUrls, T.share);
    var noShare = hasPhrase(scanWithoutUrls, T.protectiveNoShare);
    if (otpTerm && shareTerm && !noShare) {
      add('content.otpRequest', 'content', 12, otpTerm, { skill: 'otp' });
    }

    var credTerm = hasPhrase(scanWithoutUrls, T.credential);
    if (credTerm) add('content.credentialRequest', 'content', 18, credTerm, { skill: 'credential' });

    var impTerm = hasPhrase(scanWithoutUrls, T.impersonation);
    if (impTerm && !noShare && (credTerm || otpTerm || /(?:login|verify|update|blocked|refund|kyc|prize|reward)/.test(scanWithoutUrls))) {
      add('content.impersonation', 'content', 16, impTerm, {});
    }

    var greeting = hasPhrase(scanWithoutUrls, T.genericGreeting);
    if (greeting) add('content.senderGenericGreeting', 'content', 4, greeting, {});

    // --- sender id (first token of the message, as forwarded SMS text often begins with it)
    var senderMatch = raw.match(/^\s{0,3}([A-Za-z]{2}-?[A-Za-z0-9]{4,12})\s*[:\-]/);
    if (senderMatch && /^(?:vm|ad|ax|bp|im|jd|tm|vk|am|dm|cp|ms|hs|ic|mm|tx|wa)-/i.test(senderMatch[1])) {
      add('content.suspiciousSenderId', 'content', 8, senderMatch[1], {});
    }

    // --- money family
    var collectTerm = hasPhrase(scanWithoutUrls, T.collect);
    if (collectTerm) add('money.collectRequest', 'money', 32, collectTerm, { skill: 'collect' });
    var receiveTerm = hasPhrase(scanWithoutUrls, T.receiveMisconception);
    if (receiveTerm) add('money.receiveMisconception', 'money', 15, receiveTerm, {});
    var upiPinTerm = hasPhrase(scanWithoutUrls, T.upiPinRequest);
    if (upiPinTerm && (collectTerm || receiveTerm || /(?:receive|refund|cashback|credit)/.test(scanWithoutUrls))) {
      add('money.upiPinRequest', 'money', 20, upiPinTerm, {});
    }
    var sendTerm = hasPhrase(scanWithoutUrls, T.sendMoneyUrgent);
    if (sendTerm) add('money.sendMoneyUrgent', 'money', 18, sendTerm, {});
    var feeTerm = hasPhrase(scanWithoutUrls, T.feeUpfront);
    if (feeTerm) add('money.feeUpfront', 'money', 16, feeTerm, {});
    var qrTerm = hasPhrase(scanWithoutUrls, T.qrToReceive);
    if (qrTerm) add('money.qrToReceive', 'money', 18, qrTerm, {});

    // --- manipulation family
    var tooGoodTerm = hasPhrase(scanWithoutUrls, T.tooGood);
    if (tooGoodTerm && (/(?:free|offer|prize|gift|loan|job|return)/.test(scanWithoutUrls))) {
      add('manipulation.tooGood', 'manipulation', 10, tooGoodTerm, {});
    }
    var authorityTerm = hasPhrase(scanWithoutUrls, T.authority);
    if (authorityTerm) add('manipulation.authority', 'manipulation', 8, authorityTerm, {});
    var fearTerm = hasPhrase(scanWithoutUrls, T.fear);
    if (fearTerm) add('manipulation.fear', 'manipulation', 10, fearTerm, {});
    var flatteryTerm = hasPhrase(scanWithoutUrls, T.flattery);
    if (flatteryTerm) add('manipulation.flattery', 'manipulation', 5, flatteryTerm, {});
    var secrecyTerm = hasPhrase(scanWithoutUrls, T.secrecy);
    if (secrecyTerm) add('content.secrecy', 'content', 12, secrecyTerm, {});

    // --- obfuscation family
    if (hasZeroWidth) {
      add('obfuscation.zeroWidth', 'obfuscation', 10, 'zero-width characters', {
        count: countMatches(raw, new RegExp(ZERO_WIDTH.source, 'g'), 5)
      });
    }
    var homoglyph = raw.match(HOMOGLYPH);
    if (homoglyph) {
      var latinCount = (raw.match(/[A-Za-z]/g) || []).length;
      if (latinCount >= 3) add('obfuscation.homoglyph', 'obfuscation', 12, homoglyph[0], {});
    }
    var latin = (raw.match(/[A-Za-z]/g) || []).length;
    var indic = (raw.match(/[\u0900-\u097f\u0980-\u09ff\u0b80-\u0bff\u0c00-\u0c7f]/g) || []).length;
    if (latin >= 6 && indic >= 4) {
      var ratio = indic / (latin + indic);
      if (ratio > 0.15) add('obfuscation.mixedScript', 'obfuscation', 10, truncate(raw, 40), {});
    }
    var letters = raw.match(/[A-Za-z]/g) || [];
    var upper = raw.match(/[A-Z]/g) || [];
    if (letters.length >= 20 && upper.length / letters.length > 0.6) {
      add('obfuscation.allCaps', 'obfuscation', 4, truncate(raw, 40), {});
    }
    var emojiCount = countMatches(raw, EMOJI, 20);
    if (emojiCount >= 8) add('obfuscation.excessiveEmoji', 'obfuscation', 4, emojiCount + ' emoji', { count: emojiCount });

    // --- URL family
    var urlFacts = [];
    for (var u = 0; u < urls.length; u++) {
      var parsed = parseHost(urls[u]);
      urlFacts.push(parsed);
      var host = parsed.host;
      if (!host || host.indexOf('.') === -1) {
        add('url.withheldHost', 'url', 14, truncate(urls[u], 60), { url: truncate(urls[u], 120) });
        continue;
      }
      var sld = registrableDomain(host);
      var sldLabel = sld.split('.')[0];
      var pathQuery = (parsed.path + '?' + parsed.query).toLowerCase();
      var isHttp = parsed.scheme === 'http';
      var officialBrand = null;
      var brandKey;
      for (brandKey in BRANDS) {
        if (isOfficial(host, brandKey)) { officialBrand = brandKey; break; }
      }

      if (parsed.atSign) {
        add('url.atSign', 'url', 12, truncate(host, 60), { url: truncate(urls[u], 120) });
      }
      if (isIpv4(host)) {
        add('url.ipLiteral', 'url', 16, host, { url: truncate(urls[u], 120) });
      }
      if (host.indexOf('xn--') !== -1) {
        add('url.punycode', 'url', 14, truncate(host, 60), { url: truncate(urls[u], 120) });
      }
      if (SHORTENERS.indexOf(sld) !== -1 || SHORTENERS.indexOf(host) !== -1) {
        add('url.shortener', 'url', 12, sld, { domain: sld });
      }
      var labels = host.split('.').filter(Boolean);
      if (labels.length >= 4 || (labels.length >= 3 && labels[0] !== 'www' && labels.length > 3)) {
        if (labels.length - (labels[0] === 'www' ? 1 : 0) >= 4) {
          add('url.manySubdomains', 'url', 8, truncate(host, 60), { url: truncate(urls[u], 120) });
        }
      }
      var tld = labels[labels.length - 1];
      if (RISKY_TLDS.indexOf(tld) !== -1) {
        add('url.riskyTld', 'url', 10, '.' + tld, { tld: tld });
      }
      if (isHttp) {
        add('url.noTls', 'url', 8, urls[u].split('/')[0] + '//' + host, { url: truncate(urls[u], 120) });
      }
      if (/\.apk(?:$|[?#])/.test(pathQuery) || /install (?:the )?(?:apk|app)/.test(scanWithoutUrls)) {
        add('url.apkDownload', 'url', 24, truncate(pathQuery || urls[u], 60), { url: truncate(urls[u], 120) });
      }
      if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
        add('url.nonstandardPort', 'url', 8, host + ':' + parsed.port, { url: truncate(urls[u], 120) });
      }
      for (var a = 0; a < ACTION_WORDS.length; a++) {
        if (pathQuery.indexOf(ACTION_WORDS[a]) !== -1) {
          add('url.actionPath', 'url', 8, truncate(ACTION_WORDS[a] + ' — ' + host, 60), { word: ACTION_WORDS[a] });
          break;
        }
      }
      if ((parsed.query.match(/[=&]/g) || []).length >= 6 || parsed.query.length > 140) {
        add('url.longQuery', 'url', 6, truncate(parsed.query, 60), {});
      }
      if (/wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com/.test(host)) {
        add('url.whatsappLink', 'url', 6, host, { url: truncate(urls[u], 120) });
      }
      if (!officialBrand) {
        for (brandKey in BRANDS) {
          if (scanWithoutUrls.indexOf(brandKey) === -1 && host.indexOf(brandKey) === -1) continue;
          var brandInHost = host.replace(/-/g, '').indexOf(brandKey) !== -1;
          var editDistance = levenshtein(sldLabel.replace(/-/g, ''), brandKey);
          var leetDistance = levenshtein(normalizeLeet(sldLabel).replace(/-/g, ''), brandKey);
          if (brandInHost && (host.indexOf(brandKey + '.') === 0 || host.indexOf('.' + brandKey + '.') !== -1 || sldLabel.indexOf(brandKey) !== -1)) {
            add('url.brandInSubdomain', 'url', 12, truncate(host, 60), { brand: brandKey, url: truncate(urls[u], 120) });
            break;
          }
          if (editDistance <= 1 || leetDistance <= 1 || sldLabel.replace(/-/g, '') === brandKey + 'bank') {
            add('url.lookalikeBrand', 'url', 12, sldLabel, { brand: brandKey, url: truncate(urls[u], 120) });
            break;
          }
        }
      }
    }

    // --- combos across families
    var hasUrl = urls.length > 0;
    if (hasUrl && (seen['content.credentialRequest'] || seen['content.otpRequest'] || seen['money.upiPinRequest'])) {
      add('combo.linkPlusCredentialRequest', 'combo', 22, truncate(urls[0], 60), {});
    }
    if (seen['content.impersonation'] && (seen['url.lookalikeBrand'] || seen['url.brandInSubdomain'])) {
      add('combo.impersonationPlusLookalike', 'combo', 25, truncate(urls[0] || '', 60), {});
    }
    if (seen['content.urgency'] && (seen['money.sendMoneyUrgent'] || seen['money.feeUpfront'])) {
      add('combo.urgencyPlusMoneyRequest', 'combo', 20, '', {});
    }
    if (seen['content.remoteAccess'] && (seen['content.threat'] || seen['content.legalThreat'] || seen['content.digitalArrest'])) {
      add('combo.remoteAccessPlusThreat', 'combo', 22, '', {});
    }
    if (hasUrl && (seen['content.moneyBait'] || seen['manipulation.tooGood'])) {
      add('combo.prizePlusLink', 'combo', 26, truncate(urls[0], 60), {});
    }

    // --- protective signals (negative)
    if (noShare) add('protective.doNotShareWarning', 'protective', -20, noShare, {});
    if (!hasUrl) add('protective.noLinkPresent', 'protective', -8, 'no link', {});
    var txnTerm = hasPhrase(scanWithoutUrls, T.transactional);
    if (txnTerm && !hasUrl && !seen['content.credentialRequest'] && !seen['content.otpRequest']) {
      add('protective.transactionalOnly', 'protective', -20, txnTerm, {});
    }

    // --- scoring
    var score = 0;
    for (var i = 0; i < entries.length; i++) score += entries[i].weight;
    if (score < 0) score = 0;
    if (score > 100) score = 100;

    var highFloor = [
      'money.collectRequest', 'money.qrToReceive', 'content.digitalArrest', 'content.remoteAccess',
      'url.lookalikeBrand', 'url.apkDownload', 'combo.impersonationPlusLookalike',
      'combo.remoteAccessPlusThreat'
    ];
    for (var f = 0; f < highFloor.length; f++) {
      if (seen[highFloor[f]] && score < 60) score = 60;
    }
    score = Math.round(score);

    var band = score >= 60 ? 'high' : (score >= 25 ? 'suspicious' : 'safe');
    var familyCount = Object.keys(families).length;
    var confidence = 0;
    if (entries.length === 0) confidence = 0.5;
    else confidence = Math.min(1, 0.35 + 0.09 * entries.length + 0.05 * familyCount);
    if (inputTruncated) confidence = Math.max(0.4, confidence - 0.15);
    confidence = Math.round(confidence * 100) / 100;

    // --- guidance keys (ordered, deduped)
    var GUIDANCE = {
      'content.otpRequest': ['guidance.neverShareOtp', 'guidance.stopAndVerify'],
      'content.credentialRequest': ['guidance.neverShareOtp', 'guidance.verifyIndependently'],
      'content.digitalArrest': ['guidance.noMoneyToPolice', 'guidance.talkToFamily', 'guidance.reportCybercrime'],
      'content.remoteAccess': ['guidance.stopScreenShare', 'guidance.dontInstallRemoteAccess', 'guidance.reportCybercrime'],
      'content.kycBait': ['guidance.useOfficialApp', 'guidance.verifyIndependently'],
      'content.impersonation': ['guidance.verifyIndependently', 'guidance.useOfficialApp'],
      'content.familyEmergency': ['guidance.callBackOnKnownNumber', 'guidance.talkToFamily'],
      'content.investmentBait': ['guidance.noGuaranteedReturns', 'guidance.verifyIndependently'],
      'content.jobBait': ['guidance.noFeeForJob', 'guidance.verifyIndependently'],
      'content.loanBait': ['guidance.noUpfrontFee', 'guidance.verifyIndependently'],
      'content.refundDelivery': ['guidance.useOfficialApp', 'guidance.noUpiPinToReceive'],
      'content.parcelCustoms': ['guidance.noMoneyToPolice', 'guidance.verifyIndependently'],
      'content.electricityDisconnect': ['guidance.useOfficialApp', 'guidance.verifyIndependently'],
      'content.simDeactivation': ['guidance.verifyIndependently', 'guidance.useOfficialApp'],
      'content.secrecyPressure': ['guidance.talkToFamily'],
      'money.collectRequest': ['guidance.noCollectApprove', 'guidance.noUpiPinToReceive'],
      'money.upiPinRequest': ['guidance.noUpiPinToReceive', 'guidance.neverShareOtp'],
      'money.sendMoneyUrgent': ['guidance.stopAndVerify', 'guidance.verifyIndependently'],
      'money.feeUpfront': ['guidance.noPrizeFee', 'guidance.stopAndVerify'],
      'money.qrToReceive': ['guidance.noUpiPinToReceive'],
      'money.receiveMisconception': ['guidance.noUpiPinToReceive'],
      'url.shortener': ['guidance.previewLinks', 'guidance.verifyIndependently'],
      'url.lookalikeBrand': ['guidance.useOfficialApp', 'guidance.verifyIndependently'],
      'url.brandInSubdomain': ['guidance.useOfficialApp', 'guidance.verifyIndependently'],
      'url.ipLiteral': ['guidance.previewLinks', 'guidance.verifyIndependently'],
      'url.apkDownload': ['guidance.dontInstallRemoteAccess', 'guidance.verifyIndependently'],
      'url.noTls': ['guidance.previewLinks'],
      'url.riskyTld': ['guidance.previewLinks'],
      'manipulation.fear': ['guidance.calmDown', 'guidance.talkToFamily'],
      'manipulation.tooGood': ['guidance.noPrizeFee']
    };

    var guidance = [];
    var guidanceSeen = {};
    function pushGuidance(keys) {
      for (var g = 0; g < keys.length; g++) {
        if (!guidanceSeen[keys[g]]) {
          guidanceSeen[keys[g]] = true;
          guidance.push(keys[g]);
        }
      }
    }
    if (band === 'safe') {
      pushGuidance(hasUrl ? ['guidance.verifyIndependently'] : ['guidance.calmDown']);
    } else {
      for (var e = 0; e < entries.length; e++) {
        if (GUIDANCE[entries[e].id]) pushGuidance(GUIDANCE[entries[e].id]);
      }
      if (!guidance.length) pushGuidance(FALLBACK_GUIDANCE);
      if (band !== 'safe') pushGuidance(['guidance.verifyIndependently']);
    }
    guidance = guidance.slice(0, 6);

    var summaryKey = band === 'high' ? 'summary.high' : (band === 'suspicious' ? 'summary.suspicious' : 'summary.safe');

    return {
      ok: true,
      schemaVersion: 1,
      engineVersion: ENGINE_VERSION,
      lang: lang,
      input: {
        length: rawInput.length,
        truncated: inputTruncated,
        normalizedLength: unicode.length
      },
      score: score,
      band: band,
      confidence: confidence,
      summaryKey: summaryKey,
      summaryParams: { n: entries.length },
      headlineKey: 'result.band.' + band,
      indicators: entries,
      evidence: entries.slice(0, 4).map(function (entry) {
        return { id: entry.id, evidence: entry.evidence };
      }),
      urls: urlFacts.map(function (u) {
        return { url: truncate(u.raw, 200), host: u.host, tls: u.scheme === 'https' };
      }),
      // Guidance is a list of i18n keys (plain strings) so the UI can translate
      // each step directly with t(key).
      guidance: guidance.slice(),
      meta: {
        languages: [lang],
        indicatorCount: entries.length,
        families: Object.keys(families)
      }
    };
  }

  root.FS.engine = {
    version: ENGINE_VERSION,
    analyze: analyze
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.FS.engine;
  }
})();
