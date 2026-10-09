-- Run this in Supabase SQL Editor

-- Stop the browser being able to read OAuth tokens.
--
-- The connectors table holds live Google and Microsoft access and refresh
-- tokens, and its select policy is `auth.uid() = user_id`. Row-level security
-- is exactly that - row level. It decides which rows you may read, never which
-- columns, so a signed-in session could ask for the token columns and get
-- them:
--
--   await supabase.from('connectors').select('access_token, refresh_token')
--
-- Nothing in the app does that, but anything running in the page can: an
-- injected script, a browser extension, a compromised dependency. What comes
-- back is not a session-scoped key. A Google refresh token is long-lived and
-- works from anywhere, against Gmail, Drive, Sheets and Calendar, with no
-- further involvement from this app - and revoking the anon key would not
-- take it back.
--
-- Column privileges are the part RLS does not cover, so they are set here.
-- Postgres has no column-level REVOKE against a table-wide grant: the table
-- grant is dropped and the readable columns are granted back by name.

-- Kept in step with supabase/connectors-hardening.sql, which supersedes this file
-- (it also adds the single-use OAuth state table). Re-running this file after that
-- one is therefore harmless. It used to grant SELECT to `anon` as well, grant the
-- token_expires_at column, and keep DELETE for `authenticated`; none of that is
-- needed: the signed-in client reads only the columns below, and a client-side
-- DELETE would skip the provider-side token revocation done by
-- POST /api/connectors/disconnect.
revoke all on public.connectors from public, anon, authenticated;
grant select, insert, update, delete on public.connectors to service_role;
grant select (
  id,
  user_id,
  provider,
  account_email,
  status,
  scopes,
  created_at,
  updated_at
) on public.connectors to authenticated;

-- The service role is unaffected - it bypasses both RLS and column grants,
-- which is how the server continues to read tokens to call Google.

-- Verify. The first should fail with "permission denied for table connectors";
-- the second should still return the connector list.
--
--   set local role authenticated;
--   select access_token from public.connectors;   -- expected: denied
--   select provider, account_email from public.connectors;  -- expected: rows
