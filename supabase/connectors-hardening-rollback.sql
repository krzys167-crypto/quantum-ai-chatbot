-- Restores the previous (pre-hardening) privileges. Normally NOT needed: the hardening is
-- compatible with the code that was in production (only the admin Overview count used
-- `select *` on connectors, fixed in this change). If something client-side breaks, prefer fixing
-- that query to rolling this back.
-- WARNING: after this runs, every signed-in user can read their own access/refresh tokens through
-- the Data API again (audit F03). Treat it as a short, temporary measure.
-- The oauth_states table is kept (harmless, unused by old code).
begin;
set local lock_timeout = '3s';
grant all on public.connectors to authenticated;
grant all on public.connectors to anon;
commit;
