-- Read-only verification of connectors-hardening.sql. ONE result set (the Supabase SQL editor shows
-- only the last one): every row is a check with expected/actual/pass, the last row is the verdict.
-- Uses has_*_privilege and the ACL catalogs, so the answer does not depend on which role runs it.
-- No token value is ever selected.
with
cols(col) as (values ('access_token'), ('refresh_token'), ('token_expires_at')),
roles(r) as (values ('anon'), ('authenticated')),
-- 1. RLS
rls as (
  select 'oauth_states_exists' as chk, 'true' as expected, (to_regclass('public.oauth_states') is not null)::text as actual
  union all
  select 'rls_enabled:' || c.relname as chk, 'true' as expected, c.relrowsecurity::text as actual
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('connectors', 'oauth_states')
),
-- 2. client roles cannot read token columns (column or table level)
tokcols as (
  select 'no_read:' || r || '.' || col as chk, 'false' as expected,
         has_column_privilege(r, 'public.connectors', col, 'select')::text as actual
  from roles, cols
),
-- 3. nothing granted to PUBLIC (pseudo-role, ACL grantee 0) on the token columns or the tables
public_cols as (
  select 'public_has_no_column_acl:' || a.attname as chk, '0' as expected,
         count(*) filter (where x.grantee = 0)::text as actual
  from pg_attribute a
  left join lateral aclexplode(a.attacl) x on true
  where a.attrelid = 'public.connectors'::regclass and a.attname in ('access_token', 'refresh_token', 'token_expires_at')
  group by a.attname
),
public_tab as (
  select 'public_has_no_table_acl:' || c.relname as chk, '0' as expected,
         count(*) filter (where x.grantee = 0)::text as actual
  from pg_class c left join lateral aclexplode(c.relacl) x on true
  where c.oid in ('public.connectors'::regclass, to_regclass('public.oauth_states'))
  group by c.relname
),
-- 4. oauth_states is invisible to client roles
states as (
  select 'oauth_states_no_access:' || r || ':' || p as chk, 'false' as expected,
         has_table_privilege(r, to_regclass('public.oauth_states'), p)::text as actual
  from roles, (values ('select'), ('insert'), ('update'), ('delete')) as pr(p)
),
-- 5. authenticated keeps exactly what the app needs on connectors
app as (
  select 'authenticated_can_delete_connectors' as chk, 'true' as expected,
         has_table_privilege('authenticated', 'public.connectors', 'delete')::text as actual
  union all
  select 'authenticated_cannot_write_connectors', 'false',
         (has_table_privilege('authenticated', 'public.connectors', 'insert')
          or has_table_privilege('authenticated', 'public.connectors', 'update')
          or has_table_privilege('authenticated', 'public.connectors', 'truncate'))::text
  union all
  select 'anon_has_nothing_on_connectors', 'false',
         (has_table_privilege('anon', 'public.connectors', 'select,insert,update,delete,truncate,references,trigger')
          or has_column_privilege('anon', 'public.connectors', 'status', 'select'))::text
  union all
  select 'authenticated_can_read_status_column', 'true',
         has_column_privilege('authenticated', 'public.connectors', 'status', 'select')::text
),
-- 6. the server (service_role) must still work
server as (
  select 'service_role_connectors_rw' as chk, 'true' as expected,
         (has_table_privilege('service_role', 'public.connectors', 'select') and has_table_privilege('service_role', 'public.connectors', 'insert')
          and has_table_privilege('service_role', 'public.connectors', 'update') and has_table_privilege('service_role', 'public.connectors', 'delete'))::text as actual
  union all
  select 'service_role_oauth_states_rw', 'true',
         (has_table_privilege('service_role', to_regclass('public.oauth_states'), 'select') and has_table_privilege('service_role', to_regclass('public.oauth_states'), 'insert')
          and has_table_privilege('service_role', to_regclass('public.oauth_states'), 'update') and has_table_privilege('service_role', to_regclass('public.oauth_states'), 'delete'))::text
),
-- 7. views / SECURITY DEFINER functions in public that mention connectors bypass RLS and column
--    grants: there must be none (or review each by hand)
leaks as (
  select 'no_public_view_over_connectors' as chk, '0' as expected, count(*)::text as actual
  from pg_views where schemaname = 'public' and definition ~* '\mconnectors\M'
  union all
  select 'no_security_definer_fn_over_connectors', '0', count(*)::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and p.prosrc ~* '\mconnectors\M'
),
all_checks as (
  select * from rls union all select * from tokcols union all select * from public_cols
  union all select * from public_tab union all select * from states union all select * from app
  union all select * from server union all select * from leaks
),
rows_out as (
  select chk, expected, coalesce(actual, 'missing') as actual, coalesce(expected = actual, false) as pass from all_checks
)
select "check", expected, actual, result from (
  select 0 as ord, chk as "check", expected, actual, case when pass then 'PASS' else 'FAIL' end as result
  from rows_out
  union all
  select 1, '== VERDICT ==', 'all PASS',
         count(*) filter (where not pass)::text || ' failing of ' || count(*)::text,
         case when count(*) = 0 then 'FAIL (no checks ran)'
              when count(*) filter (where not pass) = 0 then 'PASS' else 'FAIL' end
  from rows_out
) q
order by ord, "check";
