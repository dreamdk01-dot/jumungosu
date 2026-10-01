/*
 * situation-search.js — 상황별 추천 검색 (키워드·동의어·예산·제외조건 규칙 기반)
 *
 * - 브라우저: <script src="/situation-search.js"> → window.SituationSearch
 * - Node 테스트: require('./situation-search.js')
 * - 외부 AI API를 호출하지 않는다. 지원하는 말만 해석하고, 못 알아들으면 "해석하지 못했다"고 돌려준다.
 *
 * 나중에 AI 문장 해석을 붙이려면 extractConditions()와 같은 모양({situationId, subtype, ...})을
 * 돌려주는 함수를 만들어 setExtractor()로 교체하면 된다. 랭킹(rankProducts)·화면은 그대로 쓴다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SituationSearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------
  // 1) 상황 정의 — 버튼 6개와 같은 순서
  //    patterns: 입력 문장에서 이 상황으로 보는 표현 (정규식)
  //    subtypes: 같은 상황 안에서 의미가 갈리는 경우의 선택지
  // ---------------------------------------------------------------
  var SITUATIONS = [
    {
      id: 'dol',
      label: '돌잔치 선물',
      short: '돌잔치',
      emoji: '🎂',
      example: '친구 아이 돌잔치 선물, 5만원 이하',
      // "돌"은 한 글자라 돌솥·돌아가다 등과 섞이지 않게 뒤 글자를 제한한다.
      patterns: [
        /돌\s*잔치/, /첫\s*돌/, /돌\s*선물/, /돌\s*축하/, /돌\s*답례/, /돌\s*파티/, /돌\s*반지/, /돌\s*떡/,
        /(^|\s)돌(?=$|\s|에|이|은|는|을|를|의|도|용|엔)/,
        /(만\s*)?1\s*(살|세)\s*(생일|선물)/,
      ],
      subtypes: [
        { id: 'attend', label: '참석 선물', hint: '돌잔치에 가서 아이·부모에게 주는 선물',
          patterns: [/참석/, /축하\s*선물/, /가서/, /(친구|지인|조카|아이).{0,6}(돌|선물)/, /선물\s*사/] },
        { id: 'return', label: '답례품', hint: '돌잔치를 연 쪽에서 손님께 드리는 답례품',
          patterns: [/답례/, /손님/, /하객/, /감사\s*선물/, /돌려/, /나눠\s*드/, /우리\s*아이\s*돌/] },
      ],
    },
    {
      id: 'season',
      label: '환절기 준비',
      short: '환절기',
      emoji: '🍂',
      example: '환절기 감기 대비, 3만원대',
      patterns: [/환절기/, /간절기/, /일교차/, /절기\s*(준비|대비)/, /가을\s*(준비|맞이)/, /면역/, /건조\s*(대비|해)/],
    },
    {
      id: 'groceries',
      label: '주말 장보기',
      short: '장보기',
      emoji: '🛒',
      example: '주말 장보기, 10만원 이하',
      patterns: [/장\s*보기/, /장\s*볼/, /주말\s*장/, /주간\s*장/, /식료품/, /먹거리\s*(준비|사)/, /마트/],
    },
    {
      id: 'housewarming',
      label: '집들이 선물',
      short: '집들이',
      emoji: '🏠',
      example: '집들이 선물, 3만원대',
      patterns: [/집들이/, /입주\s*(선물|축하)/, /새\s*집\s*(선물|축하)/, /이사\s*(선물|축하)/],
    },
    {
      id: 'solo',
      label: '자취 시작',
      short: '자취',
      emoji: '🛏️',
      example: '자취 시작 필수템, 10만원 이하',
      patterns: [/자취/, /원룸/, /독립\s*(준비|시작)/, /첫\s*독립/, /혼자\s*살/],
    },
    {
      id: 'outing',
      label: '주말 나들이',
      short: '나들이',
      emoji: '🧺',
      example: '주말 나들이 도시락, 5만원 이하',
      patterns: [/나들이/, /피크닉/, /소풍/, /도시락/, /공원\s*(가|놀)/],
    },
  ];

  var SITUATION_BY_ID = {};
  SITUATIONS.forEach(function (s) { SITUATION_BY_ID[s.id] = s; });

  // ---------------------------------------------------------------
  // 2) 받는 사람(추천대상) 표현
  // ---------------------------------------------------------------
  var RECIPIENTS = [
    { id: 'parents', label: '부모님', patterns: [/부모님/, /어머니|아버지|엄마|아빠/, /장인|장모|시부모|시댁|처가/] },
    { id: 'friend', label: '친구', patterns: [/친구/, /지인/] },
    { id: 'baby', label: '아기·아이', patterns: [/아기|아가|아이|유아|조카|애기/] },
    { id: 'work', label: '직장·거래처', patterns: [/직장|회사|동료|상사|거래처|팀원|사수/] },
    { id: 'family', label: '가족', patterns: [/가족|친척|형제|자매|언니|오빠|동생/] },
    { id: 'lover', label: '연인', patterns: [/연인|남자\s*친구|여자\s*친구|남친|여친|애인/] },
  ];

  // ---------------------------------------------------------------
  // 3) 제외조건 — 사용자가 "OO 빼고/제외/말고/없이"라고 쓴 말
  //    keywords가 상품명·태그에 들어 있으면 그 상품은 제외한다.
  // ---------------------------------------------------------------
  var EXCLUSION_TAGS = [
    { tag: 'alcohol', label: '술·주류', words: ['술', '주류', '와인', '맥주', '위스키', '소주'] },
    { tag: 'nuts', label: '견과류', words: ['견과', '견과류', '땅콩', '아몬드', '호두'] },
    { tag: 'meat', label: '고기·육류', words: ['고기', '육류', '육포', '한우', '소고기', '돼지고기'] },
    { tag: 'scented', label: '향 강한 제품', words: ['향', '향수', '방향제', '디퓨저', '캔들'] },
    { tag: 'perishable', label: '신선·냉장식품', words: ['냉장', '냉동', '신선', '과일', '회'] },
    { tag: 'sugar', label: '단 음식', words: ['설탕', '단것', '단 음식', '과자', '사탕', '초콜릿'] },
  ];

  // ---------------------------------------------------------------
  // 4) 예산 추출
  //    "5만원 이하", "3~5만원", "3만원대", "15000원 이내", "1만5천원"
  //    반환: { min, max, kind } 원 단위. 못 찾으면 null.
  // ---------------------------------------------------------------
  function parseKoreanAmount(str) {
    // "5만", "5만원", "1만5천", "5천", "15,000", "15000"
    var s = String(str).replace(/[,\s원]/g, '');
    if (!s) return null;
    var total = 0;
    var m;
    if ((m = /^(\d+(?:\.\d+)?)만(?:(\d+)천)?(?:(\d{1,4}))?$/.exec(s))) {
      total = Math.round(parseFloat(m[1]) * 10000);
      if (m[2]) total += parseInt(m[2], 10) * 1000;
      else if (m[3]) total += parseInt(m[3], 10);
      return total;
    }
    if ((m = /^(\d+)천$/.exec(s))) return parseInt(m[1], 10) * 1000;
    if ((m = /^(\d+)$/.exec(s))) return parseInt(m[1], 10);
    return null;
  }

  // 숫자+단위 덩어리 하나를 찾는 정규식 조각 (만/천/원 조합)
  var AMT = '(\\d[\\d,]*(?:\\.\\d+)?\\s*(?:만\\s*\\d*\\s*천?|천|만)?\\s*\\d{0,4}\\s*원?)';

  function extractBudget(text) {
    var t = String(text || '');
    var m;

    // 범위: "3~5만원", "3-5만원", "3만원~5만원", "3만원에서 5만원"
    var rangeRe = new RegExp(AMT + '\\s*(?:~|∼|-|에서|부터)\\s*' + AMT + '\\s*(?:사이|정도|내외)?');
    if ((m = rangeRe.exec(t))) {
      var a = m[1], b = m[2];
      // "3~5만원": 앞 숫자에 단위가 없으면 뒤 단위를 따라간다.
      var unitOf = /(만|천)\s*\d*\s*천?\s*원?\s*$/.exec(b.replace(/\s/g, ''));
      var aHasUnit = /(만|천)/.test(a);
      var lo = parseKoreanAmount(!aHasUnit && unitOf ? a.replace(/\s/g, '') + unitOf[1] : a);
      var hi = parseKoreanAmount(b);
      if (lo != null && hi != null && lo > 0 && hi > 0 && lo !== hi) {
        return { min: Math.min(lo, hi), max: Math.max(lo, hi), kind: 'range' };
      }
    }

    // "N만원대" → N만 ~ N만+9,999 (또는 천원대)
    var bandRe = /(\d+(?:\.\d+)?)\s*(만|천)\s*원?\s*대/;
    if ((m = bandRe.exec(t))) {
      var unit = m[2] === '만' ? 10000 : 1000;
      var base = Math.round(parseFloat(m[1]) * unit);
      if (base > 0) return { min: base, max: base + unit - 1, kind: 'band' };
    }

    // 이하/이내/까지/아래/미만/안쪽/넘지
    var maxRe = new RegExp(AMT + '\\s*(?:이하|이내|까지|아래|미만|안쪽|안으로|밑|넘지\\s*않)');
    if ((m = maxRe.exec(t))) {
      var mx = parseKoreanAmount(m[1]);
      if (mx && mx > 0) return { min: null, max: /미만/.test(m[0]) ? mx - 1 : mx, kind: 'max' };
    }

    // 이상/부터/넘는
    var minRe = new RegExp(AMT + '\\s*(?:이상|부터|넘는|초과)');
    if ((m = minRe.exec(t))) {
      var mn = parseKoreanAmount(m[1]);
      if (mn && mn > 0) return { min: /초과/.test(m[0]) ? mn + 1 : mn, max: null, kind: 'min' };
    }

    // 단위가 확실한 금액만 단독으로 쓴 경우: "5만원", "3만원 정도", "예산 5만원", "15000원"
    // → 보통 "그 금액 안쪽"을 뜻하므로 상한으로 해석하되 kind를 'about'으로 남겨 화면에서 수정하게 한다.
    var aloneRe = /(\d[\d,]*(?:\.\d+)?\s*(?:만\s*\d*\s*천?|천)\s*원?|\d[\d,]{3,}\s*원)/;
    if ((m = aloneRe.exec(t))) {
      var v = parseKoreanAmount(m[1]);
      if (v && v >= 1000) return { min: null, max: v, kind: 'about' };
    }
    return null;
  }

  // ---------------------------------------------------------------
  // 5) 제외조건 추출 — "견과류 빼고", "술 제외", "향 없는/없이"
  // ---------------------------------------------------------------
  function extractExclusions(text) {
    var t = String(text || '');
    var found = {};
    var re = /([가-힣A-Za-z]{1,8})\s*(?:은|는|이|가|을|를)?\s*(?:제외|빼고|빼\s*줘|말고|없이|없는|싫어|빼)/g;
    var m;
    while ((m = re.exec(t))) {
      var word = m[1];
      EXCLUSION_TAGS.forEach(function (ex) {
        if (ex.words.indexOf(word) !== -1) found[ex.tag] = ex;
      });
    }
    return Object.keys(found).map(function (k) { return { tag: found[k].tag, label: found[k].label }; });
  }

  // ---------------------------------------------------------------
  // 6) 조건 추출 본체 (교체 가능)
  // ---------------------------------------------------------------
  function matchAny(patterns, text) {
    for (var i = 0; i < patterns.length; i++) if (patterns[i].test(text)) return true;
    return false;
  }

  function defaultExtract(rawText) {
    var text = String(rawText || '').trim().slice(0, 200); // 과도한 입력 방지
    var result = {
      situationId: null,
      subtype: null,            // 'attend' | 'return' | null
      needsSubtype: false,      // 돌잔치처럼 뜻이 갈리는데 말로는 못 가렸을 때 true
      budget: null,             // {min,max,kind}
      recipients: [],           // ['parents', ...]
      exclusions: [],           // [{tag,label}]
      recognized: false,        // 상황을 하나라도 알아봤는지
      method: 'rules',
    };
    if (!text) return result;

    // 상황: 먼저 맞는 것 하나. 둘 이상 걸리면 문장에서 앞쪽에 나온 표현을 고른다.
    var best = null;
    SITUATIONS.forEach(function (s) {
      s.patterns.forEach(function (p) {
        var m = p.exec(text);
        if (m && (best === null || m.index < best.index)) best = { id: s.id, index: m.index };
      });
    });
    if (best) {
      result.situationId = best.id;
      result.recognized = true;
      var sit = SITUATION_BY_ID[best.id];
      if (sit.subtypes) {
        var hits = sit.subtypes.filter(function (st) { return matchAny(st.patterns, text); });
        if (hits.length === 1) result.subtype = hits[0].id;
        else result.needsSubtype = true;    // 0개 또는 2개 이상이면 물어본다
      }
    }

    result.budget = extractBudget(text);
    RECIPIENTS.forEach(function (r) { if (matchAny(r.patterns, text)) result.recipients.push(r.id); });
    result.exclusions = extractExclusions(text);
    return result;
  }

  var extractor = defaultExtract;
  function setExtractor(fn) { extractor = typeof fn === 'function' ? fn : defaultExtract; }
  function extractConditions(text) { return extractor(text); }

  // ---------------------------------------------------------------
  // 7) 조건 정규화·표시 도우미
  // ---------------------------------------------------------------
  function formatWon(n) {
    if (n == null) return '';
    if (n % 10000 === 0) return (n / 10000) + '만원';
    if (n >= 10000 && n % 1000 === 0) return Math.floor(n / 10000) + '만 ' + ((n % 10000) / 1000) + '천원';
    return n.toLocaleString('ko-KR') + '원';
  }

  function describeBudget(b) {
    if (!b) return '예산 제한 없음';
    if (b.kind === 'range') return formatWon(b.min) + ' ~ ' + formatWon(b.max);
    if (b.kind === 'band') return formatWon(b.min) + '대';
    if (b.min != null && b.max == null) return formatWon(b.min) + ' 이상';
    if (b.kind === 'about') return formatWon(b.max) + ' 이하(입력한 금액 기준)';
    return formatWon(b.max) + ' 이하';
  }

  // 추적용: 원문 대신 금액 구간만 남긴다.
  function budgetBucket(b) {
    if (!b) return 'none';
    if (b.max == null) return (b.min != null && b.min >= 100000) ? 'o100k' : (b.min != null ? 'open' : 'none');
    var top = b.max;
    if (top <= 30000) return 'u30k';
    if (top <= 50000) return 'u50k';
    if (top <= 100000) return 'u100k';
    return 'o100k';
  }

  // ---------------------------------------------------------------
  // 8) 랭킹 — 예산·제외조건을 먼저 걸러내고, 상황 적합성으로 정렬
  //    product 필드(서버 응답 기준):
  //      id, name, price(원, null 가능), situations[], subtypes[], recipients[],
  //      excludeTags[], reviewState('approved'만 통과), reviewedAt
  // ---------------------------------------------------------------
  function productMatchesExclusion(p, ex) {
    var tags = p.excludeTags || [];
    if (tags.indexOf(ex.tag) !== -1) return true;
    var def = null;
    for (var i = 0; i < EXCLUSION_TAGS.length; i++) if (EXCLUSION_TAGS[i].tag === ex.tag) def = EXCLUSION_TAGS[i];
    if (!def) return false;
    var name = String(p.name || '');
    for (var j = 0; j < def.words.length; j++) {
      // 한 글자 단어(술, 향, 회)는 상품명 부분일치 오탐이 커서 태그로만 판단한다.
      if (def.words[j].length >= 2 && name.indexOf(def.words[j]) !== -1) return true;
    }
    return false;
  }

  function rankProducts(products, cond, opts) {
    opts = opts || {};
    var limit = opts.limit || 6;
    var budget = cond.budget || null;
    // 승인 + 상품평 검토 기록이 있는 상품만. (서버도 같은 조건으로 거르지만, 이 함수만 따로 써도 안전하게 한 번 더 확인한다.)
    var list = (products || []).filter(function (p) { return p && p.reviewState === 'approved' && !!p.reviewVerifiedAt; });

    // (1) 이 상황에 연결된 상품만
    list = list.filter(function (p) { return (p.situations || []).indexOf(cond.situationId) !== -1; });

    // (2) 상황 안의 세부 선택(참석 선물/답례품).
    //     세부 구분이 있는 상황(돌잔치)은 상품이 해당 구분을 "명시"했을 때만 보여준다.
    //     구분이 비어 있다고 양쪽에 자동 노출하지 않는다(양쪽에 맞는 상품은 운영자가 두 항목을 모두 선택).
    var sitDef = SITUATION_BY_ID[cond.situationId];
    if (sitDef && sitDef.subtypes) {
      if (!cond.subtype) return [];                    // 세부를 고르기 전에는 어떤 상품도 내보내지 않는다
      list = list.filter(function (p) { return (p.subtypes || []).indexOf(cond.subtype) !== -1; });
    }

    // (3) 예산 — 가격 정보가 없는 상품은 예산이 있을 때 통과시키지 않는다(추측 금지).
    if (budget) {
      list = list.filter(function (p) {
        if (typeof p.price !== 'number' || !(p.price > 0)) return false;
        if (budget.min != null && p.price < budget.min) return false;
        if (budget.max != null && p.price > budget.max) return false;
        return true;
      });
    }

    // (4) 제외조건
    var exclusions = cond.exclusions || [];
    if (exclusions.length) {
      list = list.filter(function (p) {
        return !exclusions.some(function (ex) { return productMatchesExclusion(p, ex); });
      });
    }

    // (5) 상황 적합성 점수
    var recips = cond.recipients || [];
    var scored = list.map(function (p) {
      var score = 100;
      if (cond.subtype && (p.subtypes || []).indexOf(cond.subtype) !== -1) score += 30;
      // 한 구분만 명시한 상품이 양쪽을 명시한 상품보다 그 구분에 더 특화돼 있다고 보고 약간 앞에 둔다.
      if (cond.subtype && (p.subtypes || []).length === 1) score += 5;
      var pr = p.recipients || [];
      recips.forEach(function (r) { if (pr.indexOf(r) !== -1) score += 20; });
      if (recips.length && pr.length && !recips.some(function (r) { return pr.indexOf(r) !== -1; })) score -= 15;
      return { p: p, score: score };
    });
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var ra = a.p.reviewedAt || '', rb = b.p.reviewedAt || '';
      if (ra !== rb) return ra < rb ? 1 : -1;               // 최근에 검토한 것 먼저
      return String(a.p.id).localeCompare(String(b.p.id));  // 항상 같은 순서가 되도록
    });
    return scored.slice(0, limit).map(function (x) { return x.p; });
  }

  // ---------------------------------------------------------------
  // 9) 한 번에: 조건 + 결과 + 상태
  //    state: 'ok' | 'no_products' | 'need_subtype' | 'unrecognized'
  // ---------------------------------------------------------------
  function search(text, products, opts) {
    var cond = extractConditions(text);
    return resolve(cond, products, opts);
  }

  function resolve(cond, products, opts) {
    if (!cond.situationId) return { state: 'unrecognized', cond: cond, items: [] };
    var sit = SITUATION_BY_ID[cond.situationId];
    if (sit && sit.subtypes && !cond.subtype && cond.needsSubtype) {
      return { state: 'need_subtype', cond: cond, items: [] };
    }
    var items = rankProducts(products, cond, opts);
    return { state: items.length ? 'ok' : 'no_products', cond: cond, items: items };
  }

  return {
    SITUATIONS: SITUATIONS,
    SITUATION_BY_ID: SITUATION_BY_ID,
    RECIPIENTS: RECIPIENTS,
    EXCLUSION_TAGS: EXCLUSION_TAGS,
    extractConditions: extractConditions,
    extractBudget: extractBudget,
    extractExclusions: extractExclusions,
    setExtractor: setExtractor,
    rankProducts: rankProducts,
    resolve: resolve,
    search: search,
    describeBudget: describeBudget,
    budgetBucket: budgetBucket,
    formatWon: formatWon,
    parseKoreanAmount: parseKoreanAmount,
  };
});
