#!/usr/bin/env node
// Security Advisor 결과(린트 이름 → 항목 이름 배열 JSON)를 기대값과 비교한다.
//   node tools/db-apply/check-advisors.mjs actual.json [--baseline]     (--baseline: 적용 전 기준선과 비교)
// actual.json 형식: { "rls_enabled_no_policy": ["테이블명", ...], "anon_security_definer_function_executable": ["함수명(인자)", ...], ... }
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export function compareAdvisors(actual, expected) {
  const out = []; const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const k of keys) {
    const e = new Set(expected[k] || []), a = new Set(actual[k] || []);
    const added = [...a].filter((x) => !e.has(x)), removed = [...e].filter((x) => !a.has(x));
    out.push({ lint: k, expected: e.size, actual: a.size, ok: !added.length && !removed.length, unexpectedNew: added, missing: removed });
  }
  return out;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2]; if (!file) { console.error('사용법: node check-advisors.mjs actual.json [--baseline]'); process.exit(2); }
  const doc = JSON.parse(fs.readFileSync(path.join(here, 'advisor-expected.json'), 'utf8'));
  const res = compareAdvisors(JSON.parse(fs.readFileSync(file, 'utf8')), process.argv.includes('--baseline') ? doc.baseline : doc.expected_after);
  for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.lint}: 기대 ${r.expected} / 실제 ${r.actual}${r.unexpectedNew.length ? ' · 예상 밖 추가: ' + r.unexpectedNew.join(', ') : ''}${r.missing.length ? ' · 빠짐: ' + r.missing.join(', ') : ''}`);
  process.exit(res.every((r) => r.ok) ? 0 : 1);
}
