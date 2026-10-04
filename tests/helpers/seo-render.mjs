// 운영 api/seo.js 를 그대로 import 해서, 주어진 캐시 레코드로 페이지 HTML 을 만든다(Supabase 호출만 모의, 날짜 고정).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/real-cache-2026-10-03.json'), 'utf8'));
export const TODAY = '2026-10-03';

const modules = new Map();
async function load(file) {
  if (!modules.has(file)) modules.set(file, (await import(file)).default);
  return modules.get(file);
}

// seoFile: 렌더링할 seo.js 경로(수정본 또는 baseline). records: 에어테이블 레코드 배열(원본 형태).
export async function renderSeo(seoFile, page, records = FIXTURE) {
  const handler = await load(seoFile);
  const RealDate = Date;
  const FIXED = `${TODAY}T03:00:00Z`;   // 한국시간 정오
  const prevFetch = globalThis.fetch;
  const prevEnv = { u: process.env.SUPABASE_URL, k: process.env.SUPABASE_SERVICE_ROLE_KEY };
  globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); } static now() { return new RealDate(FIXED).getTime(); } };
  process.env.SUPABASE_URL = 'https://mock.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('cached_airtable_records')) return { ok: true, status: 200, json: async () => [{ records }], text: async () => '' };
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'mock' };   // 이력 통계·갱신일 조회는 실패 → 페이지가 알아서 대체
  };
  const res = { code: 200, headers: {}, body: '', status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; return this; } };
  const prevErr = console.error; console.error = () => {};
  try { await handler({ query: { page } }, res); }
  finally {
    globalThis.Date = RealDate; globalThis.fetch = prevFetch; console.error = prevErr;
    if (prevEnv.u === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevEnv.u;
    if (prevEnv.k === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevEnv.k;
  }
  if (res.code !== 200) throw new Error(`${page} → HTTP ${res.code}`);
  return res.body;
}
export const SEO_BRANCH = path.join(ROOT, 'api/seo.js');
// 비교 기준(수정 전 seo.js)은 저장소에 복사해 두지 않는다(서버 코드 사본이 정적 파일로 노출되고, 머지 후엔 낡은 코드가 되므로).
// 환경변수 SEO_BASELINE(파일 경로) 또는 git 의 SEO_BASELINE_REF(기본 main):api/seo.js 에서 테스트 시점에 꺼내 쓴다. 없으면 null.
export function resolveBaseline() {
  if (process.env.SEO_BASELINE && fs.existsSync(process.env.SEO_BASELINE)) return process.env.SEO_BASELINE;
  try {
    const ref = process.env.SEO_BASELINE_REF || 'main';
    const out = execFileSync('git', ['show', `${ref}:api/seo.js`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 20 * 1024 * 1024 });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seo-baseline-')), 'seo-baseline.mjs');
    fs.writeFileSync(file, out);
    return file;
  } catch { return null; }
}

// ---- HTML 해석 도구 ----
export const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
export function rankedList(html) {   // 카테고리 페이지의 순위 목록: [{name, amount}]
  const names = [...html.matchAll(/<span style="font-weight:700; color:#F5F0E8;">([^<]*)<\/span>/g)].map((m) => decode(m[1]));
  const amounts = [...html.matchAll(/<span style="font-family:monospace; font-weight:700; color:#FFB800;">([\d,]+)원 할인<\/span>/g)].map((m) => Number(m[1].replace(/,/g, '')));
  return names.map((name, i) => ({ name, amount: amounts[i] }));
}
export function hrefs(fragment) { return [...fragment.matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1])); }
export function navSections(html) {   // 푸터 네비: {title: [href...]}
  const nav = html.slice(html.indexOf('<nav style="margin:20px 0 28px;">'), html.indexOf('</nav>'));
  const out = {};
  for (const m of nav.matchAll(/<p style="font-size:12px; font-weight:700;[^>]*>([^<]*)<\/p>\s*<div>([\s\S]*?)<\/div>\s*<\/div>/g)) out[m[1].trim()] = hrefs(m[2]);
  return out;
}
export function h2s(html) { return [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => decode(m[1].replace(/<[^>]+>/g, '').trim())); }
export function breadcrumb(html) {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { const j = JSON.parse(m[1]); if (j['@type'] === 'BreadcrumbList') return j.itemListElement.map((i) => i.name); } catch { /* 다음 */ }
  }
  return null;
}
