-- =====================================================================================
-- JARVIS :: 000003 — knowledge base (pgvector), model configuration, tool registry
-- =====================================================================================
-- Section F requirements: knowledge documents, document chunks + embeddings, model
-- configuration, tool registry metadata and execution logs (execution_logs lives in
-- 000002 alongside the other audit tables).
-- =====================================================================================

-- -------------------------------- knowledge documents ---------------------------------

create table public.knowledge_documents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  source_type     knowledge_source not null default 'note',
  title           text not null,
  uri             text,
  status          knowledge_status not null default 'pending',
  mime_type       text,
  byte_size       int,
  -- SHA-256 of the extracted text; used to skip re-indexing unchanged documents.
  content_hash    text,
  error           text,
  metadata        jsonb not null default '{}'::jsonb,
  embedding_model text,
  chunk_count     int not null default 0,
  last_indexed_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index knowledge_documents_user_idx
  on public.knowledge_documents (user_id, updated_at desc);
create index knowledge_documents_hash_idx
  on public.knowledge_documents (user_id, content_hash);

create table public.knowledge_chunks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  document_id uuid not null references public.knowledge_documents (id) on delete cascade,
  ordinal     int not null,
  content     text not null,
  token_count int not null default 0,
  metadata    jsonb not null default '{}'::jsonb,
  -- Postgres full-text index kept in sync automatically (immutable function).
  search_tsv  tsvector generated always as (to_tsvector('english', content)) stored,
  embedding   vector(1536),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (document_id, ordinal)
);

create index knowledge_chunks_doc_idx on public.knowledge_chunks (document_id, ordinal);
create index knowledge_chunks_tsv_idx on public.knowledge_chunks using gin (search_tsv);

-- HNSW gives good recall without needing representative sample data (unlike ivfflat).
create index knowledge_chunks_embedding_idx
  on public.knowledge_chunks using hnsw (embedding vector_cosine_ops);

-- -------------------------------- memory embeddings -----------------------------------

alter table public.memories
  add column search_tsv tsvector generated always as (to_tsvector('english', title || ' ' || content)) stored,
  add column embedding vector(1536);

create index memories_tsv_idx on public.memories using gin (search_tsv);
create index memories_embedding_idx on public.memories using hnsw (embedding vector_cosine_ops);

-- ------------------------------ model configuration -----------------------------------

-- Row with user_id IS NULL is the platform default; user rows are per-account overrides.
-- The server resolves: user override by role -> global by role -> primary -> env default.
create table public.model_config (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.profiles (id) on delete cascade,
  role          text not null
                check (role in ('primary','coding','research','summary','vision','speech','embedding')),
  provider      text not null default 'openai',
  model         text not null,
  base_url      text,
  enabled       boolean not null default true,
  max_output_tokens int,
  temperature   numeric check (temperature between 0 and 2),
  -- Lower runs first when the primary is unavailable.
  fallback_order int not null default 0,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index model_config_global_role_uidx on public.model_config (role)
  where user_id is null;
create unique index model_config_user_role_uidx on public.model_config (user_id, role);

-- ---------------------------------- tool registry --------------------------------------

-- Metadata only — execution handlers live in src/lib/tools/. The registry row documents
-- what exists, its risk class and which connection it needs, so the dashboard can render
-- capability state truthfully and the agent can be restricted server-side.
create table public.tool_registry (
  name             text primary key,
  description      text not null,
  category         text not null,
  input_schema     jsonb not null,
  risk             risk_level not null default 'read',
  requires_connection text,
  requires_approval boolean not null default false,
  enabled          boolean not null default true,
  version          int not null default 1,
  updated_at       timestamptz not null default now()
);

create index tool_registry_category_idx on public.tool_registry (category, enabled);

-- =====================================================================================
-- Retrieval RPCs
-- Both are SECURITY INVOKER on purpose: Row Level Security on the underlying table is
-- the isolation mechanism, and the explicit user_id predicate is defence in depth.
-- =====================================================================================

create or replace function public.match_knowledge_chunks(
  query_embedding vector(1536),
  match_count int default 8,
  min_similarity double precision default 0.15,
  query_text text default null
)
returns table (
  id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  similarity double precision,
  keyword_rank double precision
)
language sql
stable
as $$
  -- Hybrid search via Reciprocal Rank Fusion: vector rank and full-text rank are merged
  -- so neither channel has to be tuned to the other's score scale.
  with scored as (
    select c.id,
           c.document_id,
           c.content,
           c.metadata,
           case when query_embedding is not null and c.embedding is not null
                then 1 - (c.embedding <=> query_embedding) end as similarity,
           case when query_text is not null and length(trim(query_text)) > 0
                then ts_rank(c.search_tsv, websearch_to_tsquery('english', query_text)) end as keyword_rank
    from public.knowledge_chunks c
    where c.user_id = auth.uid()
  ),
  fused as (
    select s.*,
           row_number() over (order by s.similarity  desc nulls last) as vec_rank,
           row_number() over (order by s.keyword_rank desc nulls last) as kw_rank
    from scored s
    where (s.similarity is not null and s.similarity >= min_similarity)
       or (s.keyword_rank is not null and s.keyword_rank > 0)
  )
  select id, document_id, content, metadata, similarity, keyword_rank
  from fused
  order by (1.0 / (60 + vec_rank)) + (1.0 / (60 + kw_rank)) desc
  limit greatest(match_count, 1);
$$;

create or replace function public.match_memories(
  query_embedding vector(1536) default null,
  query_text text default null,
  match_count int default 8,
  min_similarity double precision default 0.2
)
returns table (
  id uuid,
  kind text,
  title text,
  content text,
  confidence double precision,
  similarity double precision,
  keyword_rank double precision
)
language sql
stable
as $$
  with scored as (
    select m.id,
           m.kind,
           m.title,
           m.content,
           m.confidence::double precision as confidence,
           case when m.embedding is not null and query_embedding is not null
                then 1 - (m.embedding <=> query_embedding) end as similarity,
           case when query_text is not null and length(trim(query_text)) > 0
                then ts_rank(m.search_tsv, websearch_to_tsquery('english', query_text)) end as keyword_rank
    from public.memories m
    where m.user_id = auth.uid()
      and (m.expires_at is null or m.expires_at > now())
  ),
  fused as (
    select s.*,
           row_number() over (order by s.similarity  desc nulls last) as vec_rank,
           row_number() over (order by s.keyword_rank desc nulls last) as kw_rank
    from scored s
    where (s.similarity is not null and s.similarity >= min_similarity)
       or (s.keyword_rank is not null and s.keyword_rank > 0)
  )
  select id, kind, title, content, confidence, similarity, keyword_rank
  from fused
  order by (1.0 / (60 + vec_rank)) + (1.0 / (60 + kw_rank)) desc
  limit greatest(match_count, 1);
$$;

grant execute on function public.match_knowledge_chunks to authenticated, service_role;
grant execute on function public.match_memories to authenticated, service_role;
