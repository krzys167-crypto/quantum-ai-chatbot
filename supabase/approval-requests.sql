-- F09: server-held approvals for irreversible actions with third-party effects (Gmail send / reply / forward and
-- Google Calendar events that invite guests). Idempotent.
-- NOT applied automatically: review, take a backup point, then run it in the SQL editor of the project that
-- really serves production. Rollback: approval-requests-rollback.sql. Verify: verify-approval-requests.sql.
--
-- A row is the exact content the signed-in user is asked to confirm. Only the server (service_role) touches it:
-- RLS is on with no policies and every client role is revoked. Rows are short-lived (10 min) and are DELETEd when
-- the user decides, so email bodies are not kept.
begin;
set local lock_timeout = '3s';

create table if not exists public.approval_requests (
  id          uuid primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  action      text not null,
  digest      text not null,                      -- sha256 of the canonical arguments
  args        jsonb not null,                     -- exactly what is shown to the user and executed
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
-- Named and (re)created every run, so a table made by an earlier version of this script gets the current list.
alter table public.approval_requests drop constraint if exists approval_requests_action_check;
alter table public.approval_requests add constraint approval_requests_action_check
  check (action in ('send_email', 'reply_email', 'forward_email', 'create_calendar_event'));
create index if not exists approval_requests_user_expiry_idx on public.approval_requests (user_id, expires_at);

alter table public.approval_requests enable row level security;
revoke all on public.approval_requests from public, anon, authenticated;
grant select, insert, update, delete on public.approval_requests to service_role;  -- explicit: do not rely on default privileges

commit;
