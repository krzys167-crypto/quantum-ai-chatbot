-- Read-only verification of approval-requests.sql. ONE result set; the last row is the verdict.
-- Uses has_*_privilege and the catalogs, so the answer does not depend on the role running it.
with
roles(r) as (values ('anon'), ('authenticated')),
privs(p) as (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')),
checks as (
  select 'table_exists' as chk, 'true' as expected, (to_regclass('public.approval_requests') is not null)::text as actual
  union all
  select 'rls_enabled', 'true', (select c.relrowsecurity::text from pg_class c where c.oid = to_regclass('public.approval_requests'))
  union all
  select 'no_policies', '0', (select count(*)::text from pg_policies where schemaname = 'public' and tablename = 'approval_requests')
  union all
  select 'no_client_privilege:' || r || ':' || p, 'false', has_table_privilege(r, to_regclass('public.approval_requests'), p)::text
  from roles, privs
  union all
  select 'public_has_no_table_acl', '0',
         (select count(*) filter (where x.grantee = 0)::text
          from pg_class c left join lateral aclexplode(c.relacl) x on true
          where c.oid = to_regclass('public.approval_requests'))
  union all
  select 'service_role_rw', 'true',
         (has_table_privilege('service_role', to_regclass('public.approval_requests'), 'select')
          and has_table_privilege('service_role', to_regclass('public.approval_requests'), 'insert')
          and has_table_privilege('service_role', to_regclass('public.approval_requests'), 'delete'))::text
  union all
  select 'no_public_view_over_table', '0', count(*)::text
  from pg_views where schemaname = 'public' and definition ~* '\mapproval_requests\M'
),
rows_out as (
  select chk, expected, coalesce(actual, 'missing') as actual, coalesce(expected = actual, false) as pass from checks
)
select "check", expected, actual, result from (
  select 0 as ord, chk as "check", expected, actual, case when pass then 'PASS' else 'FAIL' end as result from rows_out
  union all
  select 1, '== VERDICT ==', 'all PASS',
         count(*) filter (where not pass)::text || ' failing of ' || count(*)::text,
         case when count(*) = 0 then 'FAIL (no checks ran)'
              when count(*) filter (where not pass) = 0 then 'PASS' else 'FAIL' end
  from rows_out
) q
order by ord, "check";
