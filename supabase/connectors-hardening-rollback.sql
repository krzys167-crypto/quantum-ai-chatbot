-- Restores the previous (pre-hardening) privileges. Use only if the app breaks after
-- connectors-hardening.sql. The oauth_states table is kept (harmless, unused by old code).
begin;
grant all on public.connectors to authenticated;
grant all on public.connectors to anon;
commit;
-- After a rollback the owner-readable-tokens exposure (F03) is back: treat as temporary.
