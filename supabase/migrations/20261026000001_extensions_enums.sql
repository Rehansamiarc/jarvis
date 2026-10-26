-- =====================================================================================
-- JARVIS :: 000001 — extensions and enums
-- =====================================================================================
-- Notes:
--  * pgvector is required by the knowledge base and memory retrieval (section F).
--  * Embedding dimension is fixed at 1536 to match text-embedding-3-small, the default
--    in .env.example. If you change JARVIS_EMBEDDING_DIM, ship a follow-up migration
--    that recreates the vector columns and indexes at the new width.
-- =====================================================================================

create extension if not exists "pgcrypto" with schema public;
create extension if not exists "vector" with schema public;
create extension if not exists "pg_trgm" with schema public;

-- --------------------------------- permission / safety -------------------------------
create type permission_mode as enum (
  'read_only',        -- no writes at all; JARVIS only reads and answers
  'auto_low_risk',    -- reads + reversible writes run automatically; risky actions ask
  'auto_approved',    -- user pre-approves everything except 'high' risk
  'ask_everything'    -- every side effect needs explicit confirmation
);

create type risk_level as enum ('read', 'write', 'high');

create type action_status as enum (
  'proposed', 'approved', 'denied', 'expired', 'running', 'succeeded', 'failed', 'cancelled'
);

-- ------------------------------------ conversation ----------------------------------
create type message_role as enum ('system', 'user', 'assistant', 'tool');

-- --------------------------------------- work ---------------------------------------
create type task_status as enum (
  'pending', 'planning', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'
);

create type step_status as enum (
  'pending', 'running', 'awaiting_approval', 'succeeded', 'failed', 'skipped', 'cancelled'
);

create type job_kind as enum (
  'reminder_due', 'task_run', 'automation', 'digest', 'reindex', 'maintenance', 'webhook'
);

create type job_status as enum (
  'scheduled', 'claimed', 'running', 'succeeded', 'failed', 'cancelled', 'dead'
);

-- ----------------------------------- integrations -----------------------------------
create type integration_provider as enum (
  'wordpress', 'youtube', 'gmail', 'serper', 'resend', 'webhook'
);

create type integration_status as enum (
  'not_connected', 'connected', 'needs_reauth', 'error', 'revoked'
);

-- ------------------------------------- knowledge -------------------------------------
create type knowledge_source as enum ('note', 'upload', 'url', 'youtube', 'wordpress', 'pasted');

create type knowledge_status as enum ('pending', 'indexing', 'indexed', 'failed');

-- ------------------------------------ notifications ----------------------------------
create type notification_kind as enum (
  'reminder', 'task', 'automation', 'integration_error', 'digest', 'system'
);

create type notification_level as enum ('info', 'success', 'warning', 'error');
