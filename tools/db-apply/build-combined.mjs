#!/usr/bin/env node
// 마이그레이션 2개를 하나의 트랜잭션(begin … commit)으로 묶은 결합본 combined.sql 을 만든다.
//   node tools/db-apply/build-combined.mjs          → tools/db-apply/combined.sql 갱신
// 원본 마이그레이션이 바뀌면 결합본도 다시 만들어야 하고, 회귀 테스트가 최신 여부를 검사한다.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MIGRATIONS = ['20261001000000_situation_products.sql', '20261002000000_review_verification.sql'];
export function buildCombined(root = ROOT) {
  const parts = MIGRATIONS.map((f) => { const text = fs.readFileSync(path.join(root, 'supabase', 'migrations', f), 'utf8'); return { f, text, sha: crypto.createHash('sha256').update(text).digest('hex') }; });
  return [
    '-- 상황별 쇼핑 마이그레이션 2개를 하나의 트랜잭션으로 적용하는 결합본 (자동 생성: node tools/db-apply/build-combined.mjs — 직접 수정하지 말 것)',
    ...parts.map((p, i) => `-- 원본 ${i + 1}/${parts.length}: ${p.f}  sha256=${p.sha}`),
    '-- 하나라도 실패하면 전체가 롤백된다(begin … commit). 적용 전에 preflight.sql, 적용 후에 verify-after.sql 을 실행한다.',
    'begin;',
    ...parts.flatMap((p, i) => [`\n-- ======== ${i + 1}/${parts.length} ${p.f} ========`, p.text.trimEnd()]),
    '\ncommit;',
    '',
  ].join('\n');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { fs.writeFileSync(path.join(ROOT, 'tools', 'db-apply', 'combined.sql'), buildCombined()); console.log('combined.sql 생성'); }
