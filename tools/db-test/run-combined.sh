#!/usr/bin/env bash
# 결합본(tools/db-apply/combined.sql)을 임시 Postgres 에서 검증한다. 운영 DB 와 무관. 실행: bash tools/db-test/run-combined.sh
#  1) 적용 전 점검 → 결합본 적용(한 번의 호출) → 적용 후 검증 18개 → 기능 테스트(tests.sql)
#  2) 실패 시 전체 롤백: (A) 끝에서 실패 (B) 두 마이그레이션 사이에서 실패 (C) begin/commit 없이 한 번에 보낸 경우(단일 호출의 암묵 트랜잭션)
#  3) 검증 SQL 의 민감도: 권한을 일부러 열면 FAIL 이 나오는가
#  4) 롤백 스크립트 → 객체가 사라지는가 → 재적용 가능한가
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"; APPLY="$ROOT/tools/db-apply"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"; PORT="${PGPORT_TEST:-5546}"; DATA="$(mktemp -d /tmp/pgcomb.XXXXXX)"
RUN=""; if [ "$(id -u)" = "0" ]; then chown postgres "$DATA"; chmod -R a+rX "$ROOT/supabase" "$HERE" "$APPLY"; RUN="su postgres -c"; fi
sh_() { if [ -n "$RUN" ]; then $RUN "$1"; else bash -c "$1"; fi; }
cleanup() { sh_ "$PGBIN/pg_ctl -D $DATA -m immediate stop >/dev/null 2>&1 || true"; rm -rf "$DATA" /tmp/runc.$$.sh /tmp/comb_*.$$.sql; }
trap cleanup EXIT
FAILS=0; ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; FAILS=$((FAILS+1)); }
P="$PGBIN/psql -h /tmp -p $PORT -U postgres -q"
# 한 번의 -c 호출로 파일 전체를 보내는 래퍼(Supabase 도구가 SQL 한 덩어리를 보내는 방식과 같은 단일 호출)
printf '#!/usr/bin/env bash\nexec %s -d "$1" -v ON_ERROR_STOP=1 -c "$(cat "$2")"\n' "$P" > /tmp/runc.$$.sh; chmod a+rx /tmp/runc.$$.sh
sh_ "$PGBIN/initdb -D $DATA -A trust >/dev/null"; sh_ "$PGBIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp' -l $DATA/log -w start >/dev/null"
newdb() { sh_ "$P -c 'create database $1'" && sh_ "$P -d $1 -f $HERE/stub.sql"; }
count_new() { sh_ "$P -d $1 -At -c \"select (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('situation_products','coupang_api_calls','category_review_thresholds')) + (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('is_site_admin','is_site_master','situation_products_touch','situation_products_enforce_thresholds','admin_list_situation_products','admin_save_situation_product','admin_get_situation_stats','admin_list_category_thresholds','admin_save_category_threshold','admin_delete_category_threshold'))\""; }
failing_rows() { sh_ "$P -d $1 -At -F'|' -f $2" | awk -F'|' '$4=="f"' ; }

# ---------- 1) 정상 적용 ----------
newdb t1 >/dev/null
r=$(failing_rows t1 $APPLY/preflight.sql); [ -z "$r" ] && ok "적용 전 점검(preflight) 전부 통과" || { bad "preflight"; echo "$r"; }
sh_ "/tmp/runc.$$.sh t1 $APPLY/combined.sql" >/dev/null 2>/tmp/err1.txt && ok "결합본 적용(단일 호출, 한 트랜잭션)" || { bad "결합본 적용"; head -3 /tmp/err1.txt; }
n=$(sh_ "$P -d t1 -At -F'|' -f $APPLY/verify-after.sql" | wc -l); r=$(failing_rows t1 $APPLY/verify-after.sql)
[ "$n" = "18" ] && [ -z "$r" ] && ok "적용 후 검증 18개 전부 통과" || { bad "적용 후 검증 ($n 개 행)"; echo "$r"; }
sh_ "$P -d t1 -v ON_ERROR_STOP=1 -f $HERE/tests.sql >/dev/null 2>/tmp/err2.txt" && ok "기능·권한 테스트(tests.sql) 통과" || { bad "tests.sql"; head -3 /tmp/err2.txt; }
r=$(failing_rows t1 $APPLY/preflight.sql); [ -n "$r" ] && ok "적용 후에는 preflight 가 실패한다(이미 적용된 DB 에 다시 적용하는 실수를 막음)" || bad "preflight 가 적용 후에도 통과함"
# 재적용(멱등)
sh_ "/tmp/runc.$$.sh t1 $APPLY/combined.sql" >/dev/null 2>&1 && ok "재적용도 오류 없음(멱등)" || bad "재적용 실패"

# ---------- 2) 실패 시 전체 롤백 ----------
inject() { # $1=출력 파일 $2=위치(end|mid) $3=begin/commit 유지 여부(keep|strip)
  python3 - "$APPLY/combined.sql" "$1" "$2" "$3" <<'PY'
import sys
src, out, where, mode = sys.argv[1:5]
s = open(src, encoding='utf-8').read()
marker = "-- ======== 2/2" if where == "mid" else "\ncommit;"
assert marker in s
s = s.replace(marker, "select 1/0;\n" + marker if where == "mid" else "select 1/0;" + marker, 1)
if mode == "strip":
    s = s.replace("\nbegin;\n", "\n", 1).replace("\ncommit;\n", "\n")
open(out, "w", encoding='utf-8').write(s)
PY
}
for spec in "A:end:keep:끝에서 실패" "B:mid:keep:두 마이그레이션 사이에서 실패(1번도 롤백돼야 함)" "C:mid:strip:begin/commit 없이 한 번에 보낸 경우(암묵 트랜잭션)"; do
  IFS=: read -r id where mode label <<<"$spec"; db="f$(echo $id | tr A-Z a-z)"; newdb $db >/dev/null; inject /tmp/comb_$id.$$.sql $where $mode; chmod a+r /tmp/comb_$id.$$.sql
  sh_ "/tmp/runc.$$.sh $db /tmp/comb_$id.$$.sql" >/dev/null 2>/tmp/e_$id.txt && bad "($id) 실패가 나야 하는데 성공함" || true
  grep -q "division by zero" /tmp/e_$id.txt && c=$(count_new $db) && [ "$c" = "0" ] && ok "($id) $label → 새 객체 0개(전체 롤백)" || { bad "($id) $label → 새 객체 ${c:-?}개"; head -2 /tmp/e_$id.txt; }
done
# 롤백 뒤에도 그 DB 에 정상 적용이 가능한가(찌꺼기 없음)
sh_ "/tmp/runc.$$.sh fa $APPLY/combined.sql" >/dev/null 2>&1 && [ -z "$(failing_rows fa $APPLY/verify-after.sql)" ] && ok "실패 롤백 후 정상 적용 가능(찌꺼기 없음)" || bad "실패 롤백 후 재적용"

# ---------- 3) 검증 SQL 의 민감도 (데이터가 없는 새 DB 에서: 위 tests.sql 이 t1 에 테스트 상품을 넣어 두었다) ----------
r=$(failing_rows t1 $APPLY/verify-after.sql); echo "$r" | grep -q "^15" && ok "데이터가 들어 있으면 15(새 테이블은 비어 있음)가 FAIL — 적용 직후 검증용이라는 뜻" || bad "15 가 잡지 못함"
newdb sn >/dev/null; sh_ "/tmp/runc.$$.sh sn $APPLY/combined.sql" >/dev/null 2>&1
sh_ "$P -d sn -c 'grant select on table public.situation_products to anon'"; r=$(failing_rows sn $APPLY/verify-after.sql); echo "$r" | grep -q "^06" && ok "anon 에 테이블 권한을 열면 06 이 FAIL" || bad "06 이 잡지 못함"
sh_ "$P -d sn -c 'revoke select on table public.situation_products from anon'"
sh_ "$P -d sn -c 'grant execute on function public.is_site_master() to authenticated'"; r=$(failing_rows sn $APPLY/verify-after.sql); echo "$r" | grep -q "^09" && ok "헬퍼 함수 권한을 열면 09 가 FAIL" || bad "09 가 잡지 못함"
sh_ "$P -d sn -c 'revoke execute on function public.is_site_master() from authenticated'"
sh_ "$P -d sn -c 'grant execute on function public.admin_save_situation_product(jsonb) to anon'"; r=$(failing_rows sn $APPLY/verify-after.sql); echo "$r" | grep -q "^10" && ok "관리자 RPC 를 anon 에 열면 10 이 FAIL" || bad "10 이 잡지 못함"
sh_ "$P -d sn -c 'revoke execute on function public.admin_save_situation_product(jsonb) from anon'"
sh_ "$P -d sn -c 'grant execute on function public.admin_list_situation_products() to public'"; r=$(failing_rows sn $APPLY/verify-after.sql); echo "$r" | grep -q "^12" && ok "PUBLIC 실행 권한이 생기면 12 가 FAIL" || bad "12 가 잡지 못함"
sh_ "$P -d sn -c 'revoke execute on function public.admin_list_situation_products() from public'; $P -d sn -c 'grant execute on function public.admin_list_situation_products() to authenticated'" >/dev/null
r=$(failing_rows sn $APPLY/verify-after.sql); [ -z "$r" ] && ok "원복 후 검증 18개 다시 전부 통과" || { bad "원복 후 검증"; echo "$r"; }

# ---------- 4) 롤백 스크립트 ----------
sh_ "/tmp/runc.$$.sh t1 $APPLY/rollback.sql" >/dev/null 2>&1 && c=$(count_new t1) && [ "$c" = "0" ] && ok "rollback.sql → 새 객체 0개" || bad "rollback.sql (${c:-?}개 남음)"
sh_ "$P -d t1 -At -c \"select count(*) from public.funnel_events\"" >/dev/null && ok "기존 테이블(funnel_events) 그대로" || bad "funnel_events"
sh_ "/tmp/runc.$$.sh t1 $APPLY/combined.sql" >/dev/null 2>&1 && [ -z "$(failing_rows t1 $APPLY/verify-after.sql)" ] && ok "롤백 후 재적용 가능" || bad "롤백 후 재적용"
echo; [ "$FAILS" = "0" ] && echo "결합 적용 테스트 전부 통과" || { echo "실패 $FAILS 건"; exit 1; }
