-- =====================================================================================
-- JARVIS :: 000007 — scheduler primitives (claim, lease, complete)
-- =====================================================================================
-- Design notes (section 9):
--  * Postgres is the source of truth. Cron only *wakes* the worker; it does not decide
--    what runs. A missed or duplicated invocation therefore cannot lose or double-fire
--    a reminder — every sweep drains whatever is overdue.
--  * Claims use FOR UPDATE SKIP LOCKED so concurrent sweeps (Vercel cron + an open
--    dashboard + an external pinger) never process the same row twice.
--  * A lease + claim token lets a crashed worker's job be reclaimed, while guaranteeing
--    a stale worker cannot mark a newer worker's claim as complete.
--  * SECURITY INVOKER throughout: a user-scoped client can only ever claim its own rows
--    through RLS, and the service-role client (used by cron) spans users legitimately.
-- =====================================================================================

create or replace function public.claim_scheduled_jobs(
  p_token   text,
  p_limit   int  default 10,
  p_lease_ms int default 300000,
  p_kinds   public.job_kind[] default null
)
returns setof public.scheduled_jobs
language sql
as $$
  with candidates as (
    select id
      from public.scheduled_jobs
     where (
             (status = 'scheduled' and run_at <= now())
             or
             (status in ('claimed', 'running')
              and lease_until is not null
              and lease_until < now())
           )
       and (p_kinds is null or kind = any (p_kinds))
     order by priority asc, run_at asc
     for update skip locked
     limit greatest(coalesce(p_limit, 1), 1)
  )
  update public.scheduled_jobs j
     set status      = 'claimed',
         claim_token = p_token,
         lease_until = now() + make_interval(secs => greatest(coalesce(p_lease_ms, 300000), 1000) / 1000.0),
         attempts    = j.attempts + 1,
         updated_at  = now()
    from candidates c
   where j.id = c.id
  returning j.*;
$$;

create or replace function public.complete_job(
  p_id     uuid,
  p_token  text,
  p_status public.job_status,
  p_result jsonb default null,
  p_error  text default null
)
returns boolean
language plpgsql
as $$
declare
  n int;
begin
  update public.scheduled_jobs
     set status       = p_status,
         result       = p_result,
         last_error   = p_error,
         claim_token  = null,
         lease_until  = null,
         completed_at = case when p_status in ('succeeded', 'failed', 'dead', 'cancelled')
                             then now() else null end,
         updated_at   = now()
   where id = p_id
     and claim_token = p_token;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

create or replace function public.mark_job_running(
  p_id    uuid,
  p_token text
)
returns boolean
language plpgsql
as $$
declare
  n int;
begin
  update public.scheduled_jobs
     set status     = 'running',
         lease_until = now() + interval '10 minutes',
         updated_at = now()
   where id = p_id
     and claim_token = p_token
     and status in ('claimed', 'running');
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- Re-schedule a claimed job for a later time (missed-reminder catch-up, backoff).
create or replace function public.reschedule_job(
  p_id     uuid,
  p_token  text,
  p_run_at timestamptz,
  p_reason text default null
)
returns boolean
language plpgsql
as $$
declare
  n int;
begin
  update public.scheduled_jobs
     set status      = 'scheduled',
         run_at      = p_run_at,
         claim_token = null,
         lease_until = null,
         last_error  = p_reason,
         updated_at  = now()
   where id = p_id
     and claim_token = p_token;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

grant execute on function public.claim_scheduled_jobs to authenticated, service_role;
grant execute on function public.complete_job to authenticated, service_role;
grant execute on function public.mark_job_running to authenticated, service_role;
grant execute on function public.reschedule_job to authenticated, service_role;
