#!/usr/bin/env bash
# 임시 Postgres 에서 마이그레이션 두 개를 적용하고 DB 테스트를 돌린다. 운영 DB 와 무관(로컬 임시 클러스터).
# 필요: postgresql(16 권장). root 로 실행하면 postgres 사용자로 전환한다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"; PORT="${PGPORT_TEST:-5545}"; DATA="$(mktemp -d /tmp/pgtest.XXXXXX)"
M1="$ROOT/supabase/migrations/20261001000000_situation_products.sql"
M2="$ROOT/supabase/migrations/20261002000000_review_verification.sql"
RUN=""; if [ "$(id -u)" = "0" ]; then chown postgres "$DATA"; chmod -R a+rX "$ROOT/supabase" "$HERE"; RUN="su postgres -c"; fi
sh_() { if [ -n "$RUN" ]; then $RUN "$1"; else bash -c "$1"; fi; }
cleanup() { sh_ "$PGBIN/pg_ctl -D $DATA -m immediate stop >/dev/null 2>&1 || true"; rm -rf "$DATA"; }
trap cleanup EXIT
sh_ "$PGBIN/initdb -D $DATA -A trust >/dev/null"
sh_ "$PGBIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp' -l $DATA/log -w start >/dev/null"
P="$PGBIN/psql -h /tmp -p $PORT -U postgres -q -v ON_ERROR_STOP=1"
sh_ "$P -c 'create database t'"
sh_ "$P -d t -f $HERE/stub.sql"
echo "== 마이그레이션 1 적용 후, 옛 승인 행 3개 삽입 =="
sh_ "$P -d t -f $M1 2>&1 | grep -v NOTICE || true"
sh_ "$P -d t -f $HERE/legacy_cleanup.sql"
echo "== 마이그레이션 2 적용 (+ 재실행 안전성) =="
sh_ "$P -d t -f $M2 2>&1 | grep -v NOTICE || true"
sh_ "$P -d t -f $M2 2>&1 | grep -v NOTICE || true"
sh_ "$P -d t -At -c \"select name||' → '||review_state from public.situation_products order by name\"" | tee /tmp/legacy-out.txt
grep -q "옛 승인 상품(검토 기록 없음) → hold" /tmp/legacy-out.txt && grep -q "옛 승인 돌잔치(구분 없음) → hold" /tmp/legacy-out.txt && grep -q "옛 초안 → draft" /tmp/legacy-out.txt \
  && echo "OK 기존 승인 행 정리(보류로 내림, 삭제 안 함)" || { echo "FAIL 기존 행 정리"; exit 1; }
echo "== 단정 테스트 =="
sh_ "$P -d t -f $HERE/tests.sql 2>&1 | grep -E 'NOTICE|ERROR|FAIL' | sed 's/^psql:[^ ]* //'"
sh_ "$P -d t -f $HERE/tests.sql >/dev/null 2>$DATA/err.txt || { cat $DATA/err.txt; exit 1; }"
echo "DB 테스트 통과"
