-- =====================================================================================
-- JARVIS :: 000004 — triggers, new-user provisioning, retention
-- =====================================================================================

-- --------------------------------- updated_at ----------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles','user_preferences','conversations','memories','tasks','task_steps',
    'reminders','scheduled_jobs','pending_actions','integrations','oauth_connections',
    'automation_rules','content_plans','knowledge_documents','knowledge_chunks','model_config'
  ]
  loop
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()',
      t
    );
  end loop;
end;
$$;

-- tool_registry has a plain updated_at too
create trigger set_updated_at before update on public.tool_registry
  for each row execute function public.set_updated_at();

-- ------------------------------- new user provisioning --------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;

  insert into public.user_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill anyone who already exists (safe to re-run during local development).
insert into public.profiles (id, email)
select u.id, coalesce(u.email, '')
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;

insert into public.user_preferences (user_id)
select p.id from public.profiles p
where not exists (select 1 from public.user_preferences up where up.user_id = p.id)
on conflict (user_id) do nothing;

-- ------------------------------------ retention ----------------------------------------

-- Data-retention rules: expired memories, stale notifications, and audit rows older than
-- the account's configured retention window. Called by the daily maintenance job.
create or replace function public.purge_expired()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expired_memories int := 0;
  v_notifications   int := 0;
  v_exec_logs       int := 0;
  v_action_logs     int := 0;
  v_usage_logs      int := 0;
begin
  delete from public.memories m
   where m.expires_at is not null and m.expires_at < now();
  get diagnostics v_expired_memories = row_count;

  delete from public.notifications n
   where n.read_at is not null and n.read_at < now() - interval '90 days';
  get diagnostics v_notifications = row_count;

  delete from public.execution_logs e
   using public.profiles p
   where p.id = e.user_id
     and e.created_at < now() - make_interval(days => greatest(p.retention_days, 30));
  get diagnostics v_exec_logs = row_count;

  delete from public.action_logs a
   using public.profiles p
   where p.id = a.user_id
     and a.created_at < now() - make_interval(days => greatest(p.retention_days, 30));
  get diagnostics v_action_logs = row_count;

  delete from public.usage_logs u
   using public.profiles p
   where p.id = u.user_id
     and u.created_at < now() - make_interval(days => greatest(p.retention_days, 30));
  get diagnostics v_usage_logs = row_count;

  return jsonb_build_object(
    'expired_memories', v_expired_memories,
    'notifications', v_notifications,
    'execution_logs', v_exec_logs,
    'action_logs', v_action_logs,
    'usage_logs', v_usage_logs
  );
end;
$$;

grant execute on function public.purge_expired() to service_role;

-- Release leases whose worker died so the next sweep picks the job up again.
create or replace function public.release_stale_leases()
returns int
language sql
security definer
set search_path = public
as $$
  -- A `language sql` function whose final statement is a bare UPDATE cannot be declared
  -- `returns int` (Postgres 42P13 requires SELECT/RETURNING last). The CTE carries the
  -- RETURNING clause, so the final statement is a SELECT and the count of released
  -- leases is still returned for callers that log it.
  with released as (
    update public.scheduled_jobs
       set status = 'scheduled',
           claim_token = null,
           lease_until = null,
           updated_at = now()
     where status in ('claimed','running')
       and lease_until is not null
       and lease_until < now()
    returning 1
  )
  select count(*)::int from released;
$$;

grant execute on function public.release_stale_leases() to service_role;
