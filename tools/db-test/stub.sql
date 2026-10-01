-- 로컬 임시 Postgres 전용: Supabase 가 제공하는 역할·auth.jwt()·funnel_events 를 흉내낸다. 운영 DB 에는 쓰지 않는다.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create table public.funnel_events (id bigint generated always as identity primary key, session_id text, event_name text, source text, campaign text, placement text, metadata jsonb default '{}', created_at timestamptz default now());
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;

-- 이 Supabase 프로젝트의 public 스키마 기본 권한을 흉내낸다(운영 DB 조회 결과 기준):
-- 새로 만든 테이블·함수·시퀀스에 anon/authenticated/service_role 이 기본으로 전부 부여된다.
-- 이 설정 없이는 "RLS 만으로 막혀 있는지, 권한을 실제로 회수했는지"를 구분할 수 없다.
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
