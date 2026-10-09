-- Read-only progress of the token encryption rollout (counts only, no values).
select provider,
       count(*)                                              as rows_total,
       count(*) filter (where access_token  like 'enc:v1:%') as access_sealed,
       count(*) filter (where refresh_token like 'enc:v1:%') as refresh_sealed,
       count(*) filter (where refresh_token is not null)     as refresh_present
from public.connectors
group by provider
order by provider;
