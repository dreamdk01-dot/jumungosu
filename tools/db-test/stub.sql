-- 로컬 임시 Postgres 전용: Supabase 가 제공하는 역할·auth.jwt()·funnel_events 를 흉내낸다. 운영 DB 에는 쓰지 않는다.
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create table public.funnel_events (id bigint generated always as identity primary key, session_id text, event_name text, source text, campaign text, placement text, metadata jsonb default '{}', created_at timestamptz default now());
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
