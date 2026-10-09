-- Removes the approval store. Pending requests are throw-away (10 minute lifetime).
-- WARNING: with the table gone the app (APPROVAL_MODE=server, the default) cannot release any send / reply /
-- forward, they are blocked. Roll the code back first, or set APPROVAL_MODE=legacy (reopens F09) as a stop-gap.
begin;
set local lock_timeout = '3s';
drop table if exists public.approval_requests;
commit;
