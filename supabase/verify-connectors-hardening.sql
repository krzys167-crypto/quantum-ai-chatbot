-- Read-only evidence queries for the connector hardening. They return metadata and
-- counts only; no token value is ever selected.

-- 1. RLS on, and which policies exist
select c.relname, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('connectors', 'oauth_states');

select tablename, policyname, cmd, roles, qual, with_check
from pg_policies where schemaname = 'public' and tablename in ('connectors', 'oauth_states');

-- 2. Column privileges for client roles. EXPECTED after hardening: no access_token /
--    refresh_token / token_expires_at row for anon or authenticated; none at all for oauth_states.
select table_name, column_name, grantee, privilege_type
from information_schema.column_privileges
where table_schema = 'public' and table_name in ('connectors', 'oauth_states')
  and grantee in ('anon', 'authenticated')
order by table_name, grantee, column_name, privilege_type;

-- 3. Table-level privileges for client roles (EXPECTED: connectors -> authenticated: DELETE only)
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('connectors', 'oauth_states')
  and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;

-- 4. SECURITY DEFINER functions in public (review each; none are created by these files)
select p.proname, p.proconfig as function_settings
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef;

-- 5. Encryption rollout progress (counts only)
select provider,
       count(*)                                               as rows_total,
       count(*) filter (where access_token  like 'enc:v1:%')  as access_sealed,
       count(*) filter (where refresh_token like 'enc:v1:%')  as refresh_sealed,
       count(*) filter (where refresh_token is not null)      as refresh_present
from public.connectors group by provider order by provider;
