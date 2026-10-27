-- =====================================================================================
-- JARVIS :: 000002 — core tables (identity, conversation, memory, work, integrations)
-- =====================================================================================
-- Conventions:
--  * Every user-owned row carries `user_id` so Row Level Security can be a single
--    `auth.uid() = user_id` predicate, and so service-role sweeps stay simple.
--  * `timestamptz` everywhere; the UI renders in the profile's IANA timezone.
--  * Every mutable table gets created_at/updated_at; a shared trigger maintains them.
-- =====================================================================================

-- ------------------------------------- identity --------------------------------------

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text,
  avatar_url  text,
  timezone    text not null default 'UTC',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.user_preferences (
  user_id            uuid primary key references public.profiles (id) on delete cascade,
  personality        text not null default 'witty, concise, technically precise — the JARVIS register',
  voice_enabled      boolean not null default true,
  voice_name         text,
  speech_rate        numeric not null default 1.0 check (speech_rate between 0.5 and 2.0),
  speech_pitch       numeric not null default 1.0 check (speech_pitch between 0.5 and 2.0),
  language           text not null default 'en-US',
  wake_word_enabled  boolean not null default false,
  permission_mode    permission_mode not null default 'auto_low_risk',
  notify_in_app      boolean not null default true,
  notify_email       boolean not null default false,
  digest_hour        int not null default 9 check (digest_hour between 0 and 23),
  automations_paused boolean not null default false,
  retention_days     int not null default 365 check (retention_days between 30 and 3650),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------------------------------- conversation -------------------------------------

create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  title           text not null default 'New conversation',
  summary         text,
  summary_message_count int not null default 0,
  model           text,
  archived_at     timestamptz,
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index conversations_user_recent_idx
  on public.conversations (user_id, last_message_at desc nulls last);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  role            message_role not null,
  content         text not null default '',
  -- Raw tool calls / tool results are kept as structured JSON for the audit trail.
  tool_calls      jsonb,
  tool_call_id    text,
  model           text,
  input_tokens    int,
  output_tokens   int,
  created_at      timestamptz not null default now()
);

create index messages_conversation_idx on public.messages (conversation_id, created_at);
create index messages_user_idx on public.messages (user_id, created_at desc);

-- -------------------------------------- memory ---------------------------------------

create table public.memories (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  kind            text not null default 'fact'
                  check (kind in ('preference','fact','project','date','goal','instruction','summary','other')),
  title           text not null,
  content         text not null,
  source          text not null default 'user'
                  check (source in ('user','conversation','integration','system')),
  confidence      numeric not null default 0.9 check (confidence between 0 and 1),
  pinned          boolean not null default false,
  -- Untrusted provenance: where this came from. Retrieval marks it untrusted for the model.
  origin_ref      text,
  expires_at      timestamptz,
  last_accessed_at timestamptz,
  access_count    int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index memories_user_kind_idx on public.memories (user_id, kind, updated_at desc);
create index memories_content_trgm_idx on public.memories using gin (content gin_trgm_ops);

-- --------------------------------------- tasks ---------------------------------------

create table public.tasks (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  title           text not null,
  instruction     text not null,
  plan            jsonb,
  status          task_status not null default 'pending',
  risk            risk_level not null default 'write',
  priority        int not null default 5 check (priority between 1 and 9),
  source          text not null default 'user' check (source in ('user','automation','reminder','system')),
  -- Guards against the agent re-running the same logical task when a request is retried.
  idempotency_key text,
  result_summary  text,
  error           text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index tasks_idempotency_uidx on public.tasks (user_id, idempotency_key)
  where idempotency_key is not null;
create index tasks_user_status_idx on public.tasks (user_id, status, created_at desc);

create table public.task_steps (
  id               uuid primary key default gen_random_uuid(),
  task_id          uuid not null references public.tasks (id) on delete cascade,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  step_index       int not null,
  name             text not null,
  tool_name        text,
  arguments        jsonb,
  status           step_status not null default 'pending',
  risk             risk_level not null default 'read',
  requires_approval boolean not null default false,
  approved_at      timestamptz,
  approved_by      uuid,
  attempts         int not null default 0,
  max_attempts     int not null default 3,
  result           jsonb,
  error            text,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (task_id, step_index)
);

create index task_steps_user_idx on public.task_steps (user_id, status);

-- -------------------------------------- reminders -------------------------------------

create table public.reminders (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  title             text not null,
  note              text,
  due_at            timestamptz not null,
  timezone          text not null default 'UTC',
  -- RRULE string for recurrence; null means one-shot.
  rrule             text,
  recurrence_end_at timestamptz,
  status            text not null default 'pending',
  attempts          int not null default 0,
  max_attempts      int not null default 3,
  last_error        timestamptz,
  last_fired_at     timestamptz,
  fired_count       int not null default 0,
  task_id           uuid references public.tasks (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint reminder_status_ck check (status in ('pending','snoozed','delivered','failed','cancelled'))
);

create index reminders_due_idx on public.reminders (status, due_at)
  where status in ('pending','snoozed');
create index reminders_user_idx on public.reminders (user_id, due_at);

-- ------------------------------------ scheduled jobs -----------------------------------

-- The scheduler's source of truth. A row here is what actually makes background work
-- happen with no browser open: cron (or any external pinger) drains due rows.
create table public.scheduled_jobs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  kind            job_kind not null,
  status          job_status not null default 'scheduled',
  run_at          timestamptz not null,
  priority        int not null default 5 check (priority between 1 and 9),
  payload         jsonb not null default '{}'::jsonb,
  attempts        int not null default 0,
  max_attempts    int not null default 3,
  lease_until     timestamptz,
  claim_token     text,
  idempotency_key text,
  last_error      text,
  result          jsonb,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index scheduled_jobs_idem_uidx on public.scheduled_jobs (user_id, idempotency_key)
  where idempotency_key is not null;
create index scheduled_jobs_due_idx on public.scheduled_jobs (run_at)
  where status in ('scheduled','claimed','running');
create index scheduled_jobs_user_idx on public.scheduled_jobs (user_id, status, run_at);

-- ---------------------------------- pending actions ------------------------------------

-- The confirmation gate. A side effect the model proposed but has NOT performed yet.
create table public.pending_actions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete cascade,
  task_id        uuid references public.tasks (id) on delete cascade,
  step_id        uuid references public.task_steps (id) on delete cascade,
  action_name    text not null,
  risk           risk_level not null default 'write',
  title          text not null,
  -- Human-readable, action-specific preview shown in the confirm dialog.
  preview        jsonb not null default '{}'::jsonb,
  payload        jsonb not null default '{}'::jsonb,
  status         action_status not null default 'proposed',
  expires_at     timestamptz not null default now() + interval '10 minutes',
  decided_at     timestamptz,
  executed_at    timestamptz,
  result         jsonb,
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index pending_actions_user_idx on public.pending_actions (user_id, status, created_at desc);

-- ------------------------------------ integrations -------------------------------------

create table public.integrations (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles (id) on delete cascade,
  provider              integration_provider not null,
  label                 text not null default 'default',
  status                integration_status not null default 'not_connected',
  -- Non-secret configuration only (site URL, channel id, from-address…).
  config                jsonb not null default '{}'::jsonb,
  -- AES-256-GCM ciphertext produced server-side by src/lib/crypto/secrets.ts.
  -- Never returned by any API; select is revoked below and the column is filtered out.
  encrypted_credentials text,
  granted_scopes        text[] not null default '{}',
  last_checked_at       timestamptz,
  last_error            text,
  connected_at          timestamptz,
  disconnected_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, provider, label)
);

create table public.oauth_connections (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles (id) on delete cascade,
  provider              text not null,
  status                integration_status not null default 'connected',
  granted_scopes        text[] not null default '{}',
  access_token_encrypted  text,
  refresh_token_encrypted text,
  expires_at            timestamptz,
  token_type            text default 'Bearer',
  external_subject      text,
  external_profile      jsonb,
  last_refreshed_at     timestamptz,
  revoked_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, provider)
);

-- ------------------------------------ automations ---------------------------------------

create table public.automation_rules (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  name           text not null,
  description    text,
  trigger_type   text not null check (trigger_type in ('schedule','keyword')),
  trigger_config jsonb not null default '{}'::jsonb,
  instruction    text not null,
  enabled        boolean not null default true,
  run_count      int not null default 0,
  last_run_at    timestamptz,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index automation_rules_user_idx on public.automation_rules (user_id, enabled);

-- --------------------------------- logs and reporting -----------------------------------

create table public.action_logs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  task_id         uuid references public.tasks (id) on delete set null,
  pending_action_id uuid references public.pending_actions (id) on delete set null,
  action_name     text not null,
  target          text,
  risk            risk_level not null default 'write',
  status          action_status not null,
  -- What we asked the provider to do, and what it actually answered.
  request         jsonb,
  response        jsonb,
  error           text,
  duration_ms     int,
  idempotency_key text,
  created_at      timestamptz not null default now()
);

create index action_logs_user_idx on public.action_logs (user_id, created_at desc);
create index action_logs_status_idx on public.action_logs (user_id, status, created_at desc);

-- One row per tool invocation inside an agent run (read-only calls included).
create table public.execution_logs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  run_id          uuid not null,
  conversation_id uuid references public.conversations (id) on delete set null,
  step            int not null default 0,
  tool_name       text not null,
  arguments       jsonb,
  -- `rejected` means the server refused the call before executing it (schema or permission).
  status          text not null check (status in ('ok','rejected','error','timeout')),
  validation_error text,
  output          jsonb,
  duration_ms     int,
  created_at      timestamptz not null default now()
);

create index execution_logs_user_idx on public.execution_logs (user_id, created_at desc);
create index execution_logs_run_idx on public.execution_logs (run_id);

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       notification_kind not null default 'system',
  level      notification_level not null default 'info',
  title      text not null,
  body       text,
  link       text,
  metadata   jsonb not null default '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id, created_at desc)
  where read_at is null;

create table public.content_plans (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  title          text not null,
  platform       text not null check (platform in ('youtube','wordpress','both')),
  status         text not null default 'draft' check (status in ('draft','scheduled','published','discarded')),
  scheduled_for  timestamptz,
  topic          text,
  payload        jsonb not null default '{}'::jsonb,
  source_task_id uuid references public.tasks (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index content_plans_user_idx on public.content_plans (user_id, created_at desc);

create table public.usage_logs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  provider        text not null,
  model           text not null,
  operation       text not null check (operation in ('chat','embed','stt','tts','tool')),
  input_tokens    int not null default 0,
  output_tokens   int not null default 0,
  cost_usd        numeric(12, 6) not null default 0,
  latency_ms      int,
  conversation_id uuid references public.conversations (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index usage_logs_user_idx on public.usage_logs (user_id, created_at desc);
-- Monthly rollup index. `date_trunc(text, timestamptz)` is only STABLE, so it cannot appear in
-- a plain index expression (Postgres rejects it with 42P17). The three-argument overload that
-- takes an explicit zone is IMMUTABLE, which makes this indexable; UTC keeps the bucketing
-- deterministic regardless of the server TimeZone.
create index usage_logs_month_idx on public.usage_logs (user_id, date_trunc('month', created_at, 'UTC'));
