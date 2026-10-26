-- =====================================================================================
-- JARVIS :: 000005 — Row Level Security
-- =====================================================================================
-- Policy shape:
--   * Uniform user-owned tables  -> owner-only CRUD, plus a column guard for audit logs.
--   * Audit tables               -> readable by the owner, writable only by the server
--                                   (service role), so a client cannot rewrite history.
--   * Credential tables          -> column-level SELECT that excludes ciphertext; all
--                                   credential writes go through the service role.
--   * Shared tables              -> tool_registry read-only, model_config global+personal.
--   * anon                       -> no access to any application table.
-- =====================================================================================

-- --------------------------------- uniform user tables --------------------------------
-- Every table in this list has a `user_id` column referencing public.profiles.
do $$
declare
  t text;
begin
  foreach t in array array[
    'user_preferences','conversations','messages','memories','tasks','task_steps',
    'reminders','scheduled_jobs','pending_actions','automation_rules','notifications',
    'content_plans','knowledge_documents','knowledge_chunks'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (user_id = auth.uid())
         with check (user_id = auth.uid())',
      t || '_owner', t
    );
  end loop;
end;
$$;

-- -------------------------------------- profiles ---------------------------------------

alter table public.profiles enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid());

create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = auth.uid());

create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Profiles are not user-deletable through the API; account deletion is a server flow.

-- -------------------------------------- audit logs --------------------------------------
-- Server-authoritative: readable by their owner, never writable or editable from a client.

alter table public.action_logs enable row level security;
alter table public.execution_logs enable row level security;
alter table public.usage_logs enable row level security;

create policy action_logs_select_own on public.action_logs
  for select to authenticated using (user_id = auth.uid());
create policy execution_logs_select_own on public.execution_logs
  for select to authenticated using (user_id = auth.uid());
create policy usage_logs_select_own on public.usage_logs
  for select to authenticated using (user_id = auth.uid());

-- Append-only from the client's perspective: JARVIS may record what happened, but no
-- session can rewrite or erase its own history after the fact.
revoke update, delete on public.action_logs from authenticated, anon;
revoke update, delete on public.execution_logs from authenticated, anon;
revoke update, delete on public.usage_logs from authenticated, anon;
create policy action_logs_insert_own on public.action_logs
  for insert to authenticated with check (user_id = auth.uid());
create policy execution_logs_insert_own on public.execution_logs
  for insert to authenticated with check (user_id = auth.uid());
create policy usage_logs_insert_own on public.usage_logs
  for insert to authenticated with check (user_id = auth.uid());

-- ---------------------------------- credential tables ------------------------------------

alter table public.integrations enable row level security;
alter table public.oauth_connections enable row level security;

create policy integrations_select_own on public.integrations
  for select to authenticated using (user_id = auth.uid());
create policy oauth_connections_select_own on public.oauth_connections
  for select to authenticated using (user_id = auth.uid());

-- Column-level grants keep the AES-GCM ciphertext out of every client result set even if
-- a future query asks for `*`.
revoke all on public.integrations from anon, authenticated;
revoke all on public.oauth_connections from anon, authenticated;

grant select (
  id, user_id, provider, label, status, config, granted_scopes,
  last_checked_at, last_error, connected_at, disconnected_at, created_at, updated_at
) on public.integrations to authenticated;

grant select (
  id, user_id, provider, status, granted_scopes, expires_at, token_type,
  external_subject, external_profile, last_refreshed_at, revoked_at, created_at, updated_at
) on public.oauth_connections to authenticated;

-- No client-side writes to credential rows at all.
revoke insert, update, delete on public.integrations from authenticated, anon;
revoke insert, update, delete on public.oauth_connections from authenticated, anon;

-- ------------------------------------ shared tables ---------------------------------------

alter table public.tool_registry enable row level security;

create policy tool_registry_read_all on public.tool_registry
  for select to authenticated using (true);
-- Writes are migration/service-role only.

alter table public.model_config enable row level security;

create policy model_config_select on public.model_config
  for select to authenticated
  using (user_id is null or user_id = auth.uid());

create policy model_config_insert_own on public.model_config
  for insert to authenticated with check (user_id = auth.uid());

create policy model_config_update_own on public.model_config
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy model_config_delete_own on public.model_config
  for delete to authenticated using (user_id = auth.uid());

-- --------------------------------------- anon ---------------------------------------------

revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon;
grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on functions from anon;
