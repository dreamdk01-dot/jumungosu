-- 마이그레이션 1 만 적용된 상태에서 승인돼 있던 행이 2 적용 시 보류로 내려가는지 확인한다(데이터는 보존).
\set ON_ERROR_STOP on
\pset tuples_only on
insert into public.situation_products (name, review_state, situations, subtypes, reason, affiliate_url)
values ('옛 승인 상품(검토 기록 없음)', 'approved', '{housewarming}', '{}', '이유', 'https://link.coupang.com/a/old'),
       ('옛 승인 돌잔치(구분 없음)',   'approved', '{dol}',          '{}', '이유', 'https://link.coupang.com/a/old2'),
       ('옛 초안',                      'draft',    '{solo}',         '{}', null,   null);
