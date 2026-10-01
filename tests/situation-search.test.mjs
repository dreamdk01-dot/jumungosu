import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 브라우저에서 <script>로 로드되는 것과 같은 방식으로(= package.json 의 module/commonjs 설정과 무관하게) 파일을 실행한다.
// 같은 realm 에서 실행해야 deepEqual 이 객체 프로토타입 차이로 틀어지지 않는다.
function loadSituationSearch() {
  const code = fs.readFileSync(new URL('../situation-search.js', import.meta.url), 'utf8');
  const mod = { exports: {} };
  new Function('module', code)(mod);
  return mod.exports;
}
const S = loadSituationSearch();

const ex = (t) => S.extractConditions(t);

test('상황: 돌잔치 동의어가 같은 상황으로 연결된다', () => {
  for (const t of ['돌 선물', '돌잔치 선물', '첫돌 선물', '첫 돌 선물', '친구 아이 돌잔치 선물', '돌 축하', '돌 답례품', '돌에 뭐 사가지', '1살 생일 선물']) {
    assert.equal(ex(t).situationId, 'dol', t);
  }
});

test('상황: "돌"이 들어간 다른 단어를 돌잔치로 오인하지 않는다', () => {
  for (const t of ['돌솥밥 재료 장보기', '돌아가는 길에 장보기', '돌김 주말 장보기']) {
    assert.notEqual(ex(t).situationId, 'dol', t);
  }
  assert.equal(ex('돌솥밥 재료 장보기').situationId, 'groceries');
});

test('돌잔치만 쓰면 참석 선물/답례품을 물어봐야 한다', () => {
  const r = ex('돌잔치');
  assert.equal(r.situationId, 'dol');
  assert.equal(r.needsSubtype, true);
  assert.equal(r.subtype, null);
  assert.equal(S.resolve(r, []).state, 'need_subtype');
});

test('돌잔치 세부 구분: 말에서 가려지면 묻지 않는다', () => {
  assert.equal(ex('돌잔치 답례품').subtype, 'return');
  assert.equal(ex('돌잔치 손님 선물').subtype, 'return');
  assert.equal(ex('돌잔치 참석 선물').subtype, 'attend');
  assert.equal(ex('돌잔치 답례품').needsSubtype, false);
  // 양쪽 신호가 같이 있으면 추측하지 않고 묻는다
  assert.equal(ex('돌잔치 참석 답례품').needsSubtype, true);
});

test('나머지 상황 인식', () => {
  assert.equal(ex('환절기 준비').situationId, 'season');
  assert.equal(ex('일교차 큰 날 대비').situationId, 'season');
  assert.equal(ex('주말 장보기').situationId, 'groceries');
  assert.equal(ex('장 보기').situationId, 'groceries');
  assert.equal(ex('집들이 선물').situationId, 'housewarming');
  assert.equal(ex('자취 시작').situationId, 'solo');
  assert.equal(ex('원룸 첫 독립').situationId, 'solo');
  assert.equal(ex('주말 나들이').situationId, 'outing');
  assert.equal(ex('피크닉 도시락').situationId, 'outing');
});

test('지원하지 않는 문장은 해석하지 못했다고 돌려준다', () => {
  for (const t of ['', '   ', '아무거나 추천해줘', '결혼 기념일 선물', 'asdf']) {
    const r = ex(t);
    assert.equal(r.recognized, false, t);
    assert.equal(S.resolve(r, []).state, 'unrecognized', t);
  }
});

test('예산: 이하/이내/까지/아래/미만', () => {
  assert.deepEqual(S.extractBudget('5만원 이하'), { min: null, max: 50000, kind: 'max' });
  assert.deepEqual(S.extractBudget('5만원 이내'), { min: null, max: 50000, kind: 'max' });
  assert.deepEqual(S.extractBudget('50000원 이하'), { min: null, max: 50000, kind: 'max' });
  assert.deepEqual(S.extractBudget('50,000원까지'), { min: null, max: 50000, kind: 'max' });
  assert.deepEqual(S.extractBudget('3만원 아래'), { min: null, max: 30000, kind: 'max' });
  assert.deepEqual(S.extractBudget('10만원 미만'), { min: null, max: 99999, kind: 'max' });
  assert.deepEqual(S.extractBudget('1만5천원 이하'), { min: null, max: 15000, kind: 'max' });
  assert.deepEqual(S.extractBudget('5천원 이하'), { min: null, max: 5000, kind: 'max' });
});

test('예산: 범위·대·이상', () => {
  assert.deepEqual(S.extractBudget('3~5만원'), { min: 30000, max: 50000, kind: 'range' });
  assert.deepEqual(S.extractBudget('3만원~5만원'), { min: 30000, max: 50000, kind: 'range' });
  assert.deepEqual(S.extractBudget('3만원에서 5만원'), { min: 30000, max: 50000, kind: 'range' });
  assert.deepEqual(S.extractBudget('3만원대'), { min: 30000, max: 39999, kind: 'band' });
  assert.deepEqual(S.extractBudget('10만원 이상'), { min: 100000, max: null, kind: 'min' });
});

test('예산: 단독 금액은 상한(about)으로 해석하되 표시해서 고칠 수 있게 한다', () => {
  assert.deepEqual(S.extractBudget('예산 5만원'), { min: null, max: 50000, kind: 'about' });
  assert.deepEqual(S.extractBudget('3만원 정도'), { min: null, max: 30000, kind: 'about' });
});

test('예산: 금액이 아닌 숫자는 예산으로 오인하지 않는다', () => {
  assert.equal(S.extractBudget('1살 생일 선물'), null);
  assert.equal(S.extractBudget('2명이서 쓸 것'), null);
  assert.equal(S.extractBudget('돌잔치 선물'), null);
  assert.equal(S.extractBudget('10개 묶음'), null);
});

test('예산 표시와 추적용 구간(원문 미저장)', () => {
  assert.equal(S.describeBudget(null), '예산 제한 없음');
  assert.equal(S.describeBudget({ min: null, max: 50000, kind: 'max' }), '5만원 이하');
  assert.equal(S.describeBudget({ min: 30000, max: 50000, kind: 'range' }), '3만원 ~ 5만원');
  assert.equal(S.budgetBucket(null), 'none');
  assert.equal(S.budgetBucket({ min: null, max: 30000 }), 'u30k');
  assert.equal(S.budgetBucket({ min: null, max: 50000 }), 'u50k');
  assert.equal(S.budgetBucket({ min: null, max: 80000 }), 'u100k');
  assert.equal(S.budgetBucket({ min: 100000, max: null }), 'o100k');
});

test('받는 사람·제외조건 추출', () => {
  assert.deepEqual(ex('부모님 집들이 선물').recipients, ['parents']);
  assert.deepEqual(ex('친구 아이 돌잔치 선물').recipients.sort(), ['baby', 'friend']);
  assert.deepEqual(ex('집들이 선물 술 빼고').exclusions.map(e => e.tag), ['alcohol']);
  assert.deepEqual(ex('견과류 제외하고 선물').exclusions.map(e => e.tag), ['nuts']);
  assert.deepEqual(ex('향 없는 집들이 선물').exclusions.map(e => e.tag), ['scented']);
  assert.deepEqual(ex('집들이 선물').exclusions, []);
});

test('원문 입력 길이는 해석 단계에서 자른다', () => {
  const long = '집들이 선물 ' + 'ㅋ'.repeat(5000);
  assert.equal(ex(long).situationId, 'housewarming');
});

// ---- 랭킹 ----
const P = (o) => Object.assign({ id: 'x', name: '상품', price: 30000, reviewState: 'approved', situations: ['housewarming'], subtypes: [], recipients: [], excludeTags: [], reviewedAt: '2026-09-30', reviewVerifiedAt: '2026-09-29' }, o);

test('랭킹: 승인된 상품만 노출한다', () => {
  const items = [P({ id: 'a' }), P({ id: 'b', reviewState: 'draft' }), P({ id: 'c', reviewState: 'rejected' }), P({ id: 'd', reviewState: 'hold' })];
  const r = S.rankProducts(items, { situationId: 'housewarming' });
  assert.deepEqual(r.map(p => p.id), ['a']);
});

test('랭킹: 다른 상황의 상품은 나오지 않는다', () => {
  const items = [P({ id: 'a' }), P({ id: 'b', situations: ['solo'] })];
  assert.deepEqual(S.rankProducts(items, { situationId: 'housewarming' }).map(p => p.id), ['a']);
});

test('랭킹: 예산을 먼저 적용하고, 가격 정보가 없는 상품은 예산이 있을 때 제외한다', () => {
  const items = [P({ id: 'cheap', price: 20000 }), P({ id: 'mid', price: 45000 }), P({ id: 'high', price: 80000 }), P({ id: 'nop', price: null })];
  const cond = { situationId: 'housewarming', budget: { min: null, max: 50000, kind: 'max' } };
  assert.deepEqual(S.rankProducts(items, cond).map(p => p.id).sort(), ['cheap', 'mid']);
  // 예산이 없으면 가격 없는 상품도 후보(가격은 카드에서 "쿠팡에서 확인")
  assert.equal(S.rankProducts(items, { situationId: 'housewarming' }).length, 4);
  // 범위
  const r = S.rankProducts(items, { situationId: 'housewarming', budget: { min: 30000, max: 50000, kind: 'range' } });
  assert.deepEqual(r.map(p => p.id), ['mid']);
});

test('랭킹: 제외조건(태그·상품명)을 예산 다음에 적용한다', () => {
  const items = [P({ id: 'wine', name: '와인 세트', excludeTags: ['alcohol'] }), P({ id: 'tag', name: '선물', excludeTags: ['nuts'] }), P({ id: 'ok', name: '디퓨저 없는 수건' })];
  const none = S.rankProducts(items, { situationId: 'housewarming', exclusions: [{ tag: 'alcohol' }] });
  assert.deepEqual(none.map(p => p.id).sort(), ['ok', 'tag']);
  const both = S.rankProducts(items, { situationId: 'housewarming', exclusions: [{ tag: 'alcohol' }, { tag: 'nuts' }] });
  assert.deepEqual(both.map(p => p.id), ['ok']);
  // 상품명 부분일치는 두 글자 이상 단어만 (한 글자 '향' 같은 오탐 방지)
  const scent = S.rankProducts([P({ id: 'a', name: '방향 없는 수건' })], { situationId: 'housewarming', exclusions: [{ tag: 'scented' }] });
  assert.equal(scent.length, 1);
});

// [동작 변경] 이전: subtypes 가 비어 있으면 참석 선물·답례품 양쪽에 노출 → 이제: 비어 있으면 어느 쪽에도 노출하지 않는다.
// 양쪽에 맞는 상품은 운영자가 ['attend','return'] 두 항목을 명시해야 한다.
test('랭킹: 돌잔치 세부 구분은 명시한 상품만 — 비어 있다고 양쪽에 자동 노출하지 않는다', () => {
  const items = [
    P({ id: 'att', situations: ['dol'], subtypes: ['attend'] }),
    P({ id: 'ret', situations: ['dol'], subtypes: ['return'] }),
    P({ id: 'both', situations: ['dol'], subtypes: ['attend', 'return'] }),
    P({ id: 'empty', situations: ['dol'], subtypes: [] }),
  ];
  assert.deepEqual(S.rankProducts(items, { situationId: 'dol', subtype: 'attend' }).map(p => p.id).sort(), ['att', 'both']);
  assert.deepEqual(S.rankProducts(items, { situationId: 'dol', subtype: 'return' }).map(p => p.id).sort(), ['both', 'ret']);
  // 세부를 아직 안 골랐으면 아무것도 내보내지 않는다
  assert.deepEqual(S.rankProducts(items, { situationId: 'dol', subtype: null }), []);
  // 한 구분만 명시한 상품이 양쪽 명시 상품보다 그 구분에서 앞선다
  assert.equal(S.rankProducts(items, { situationId: 'dol', subtype: 'attend' })[0].id, 'att');
  // 돌잔치가 아닌 상황은 subtypes 와 무관
  assert.deepEqual(S.rankProducts([P({ id: 'x', subtypes: [] })], { situationId: 'housewarming' }).map(p => p.id), ['x']);
});

test('랭킹: 상품평 검토 기록(reviewVerifiedAt)이 없는 상품은 승인 상태여도 노출하지 않는다', () => {
  const items = [P({ id: 'ok' }), P({ id: 'noreview', reviewVerifiedAt: null }), P({ id: 'undef', reviewVerifiedAt: undefined })];
  assert.deepEqual(S.rankProducts(items, { situationId: 'housewarming' }).map(p => p.id), ['ok']);
  assert.equal(S.resolve({ situationId: 'housewarming', exclusions: [], recipients: [] }, [P({ reviewVerifiedAt: null })]).state, 'no_products');
});

test('랭킹: 받는 사람이 맞는 상품이 먼저, 결과는 최대 6개, 순서는 항상 같다', () => {
  const items = [];
  for (let i = 0; i < 10; i++) items.push(P({ id: 'p' + i, recipients: i === 7 ? ['parents'] : ['friend'] }));
  const cond = { situationId: 'housewarming', recipients: ['parents'] };
  const r = S.rankProducts(items, cond);
  assert.equal(r.length, 6);
  assert.equal(r[0].id, 'p7');
  assert.deepEqual(S.rankProducts(items, cond).map(p => p.id), r.map(p => p.id));
});

test('resolve: 상태 구분 — 상품 없음은 가짜로 채우지 않는다', () => {
  assert.equal(S.resolve(ex('집들이 선물'), []).state, 'no_products');
  assert.equal(S.resolve(ex('집들이 선물'), [P()]).state, 'ok');
  assert.equal(S.resolve(ex('맞는 게 없는 말'), [P()]).state, 'unrecognized');
});

test('추출기 교체(setExtractor): 같은 모양의 조건을 돌려주면 랭킹은 그대로 동작', () => {
  S.setExtractor(() => ({ situationId: 'solo', subtype: null, needsSubtype: false, budget: null, recipients: [], exclusions: [], recognized: true, method: 'ai' }));
  const r = S.search('아무 말', [P({ id: 'z', situations: ['solo'] })]);
  assert.equal(r.state, 'ok');
  assert.equal(r.cond.method, 'ai');
  S.setExtractor(null);
  assert.equal(S.extractConditions('집들이').situationId, 'housewarming');
});
