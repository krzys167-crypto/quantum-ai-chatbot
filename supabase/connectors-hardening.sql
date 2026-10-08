-- Connector hardening: F01/F02 (server-side OAuth state) and F03 (tokens not readable
-- through the Data API). Idempotent. NOT applied automatically: review, then run in the
-- SQL editor of the project that actually serves production. Rollback: connectors-hardening-rollback.sql
begin;

-- 1. OAuth state: single use, short TTL, bound to the user who started the flow.
--    Only the service role (bypasses RLS) ever touches it; no policies on purpose.
create table if not exists public.oauth_states (
  state_hash  text primary key,                       -- sha256(state); the raw state is never stored
  user_id     uuid not null references auth.users(id) on delete cascade,
  provider    text not null,
  family      text not null check (family in ('google', 'microsoft')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);
create index if not exists oauth_states_expires_at_idx on public.oauth_states (expires_at);
alter table public.oauth_states enable row level security;
revoke all on public.oauth_states from anon, authenticated;

-- 2. Tokens must not be readable by client roles, even for the owner's own rows.
--    The app reads connector status through explicit columns only (Connectors.tsx).
revoke all on public.connectors from anon, authenticated;
grant select (id, user_id, provider, account_email, status, scopes, created_at, updated_at)
  on public.connectors to authenticated;
grant delete on public.connectors to authenticated;  -- still limited to own rows by the existing policy

commit;
