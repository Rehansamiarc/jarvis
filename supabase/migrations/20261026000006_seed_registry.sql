-- =====================================================================================
-- JARVIS :: 000006 — seed global model configuration and tool registry metadata
-- =====================================================================================
-- NOTE: This is platform configuration, not demo user data. No fake profiles, no fake
-- conversations, no fabricated integrations. Demo data (if ever wanted) belongs in a
-- clearly-marked supabase/seed.sql that is only applied to local/dev branches.
-- =====================================================================================

insert into public.model_config (user_id, role, provider, model, fallback_order, notes) values
  (null, 'primary',   'openai', 'gpt-5-mini',       0, 'Default conversational model'),
  (null, 'coding',    'openai', 'gpt-5',            0, 'Specialist: code generation and review'),
  (null, 'research',  'openai', 'gpt-5',            0, 'Specialist: multi-step research / long context'),
  (null, 'summary',   'openai', 'gpt-5-mini',       0, 'Specialist: cheap, fast summarisation'),
  (null, 'vision',    'openai', 'gpt-5-mini',       0, 'Specialist: image understanding'),
  (null, 'speech',    'openai', 'gpt-5-mini',       0, 'Specialist: STT/TTS orchestration prompts'),
  (null, 'embedding', 'openai', 'text-embedding-3-small', 0, 'Knowledge base + memory embeddings (1536d)')
on conflict do nothing;

-- Tool metadata mirrors src/lib/tools/*. The input_schema here is the contract that the
-- dashboard renders and that the server validates against at execution time.
insert into public.tool_registry
  (name, description, category, input_schema, risk, requires_connection, requires_approval, enabled)
values
  ('memory.search', 'Search long-term personal memories by meaning or keyword.', 'memory',
   '{"query":{"type":"string","required":true},"limit":{"type":"integer"}}'::jsonb, 'read', null, false, true),

  ('memory.save', 'Persist a durable fact, preference, project or goal for later recall.',
   'memory',
   '{"title":{"type":"string","required":true},"content":{"type":"string","required":true},"kind":{"type":"string","enum":["preference","fact","project","date","goal","instruction","other"]}}'::jsonb,
   'write', null, false, true),

  ('memory.delete', 'Forget a stored memory by id.', 'memory',
   '{"id":{"type":"string","required":true}}'::jsonb, 'high', null, true, true),

  ('knowledge.search', 'Semantic + keyword search of the personal knowledge base.',
   'knowledge',
   '{"query":{"type":"string","required":true},"limit":{"type":"integer"}}'::jsonb, 'read', null, false, true),

  ('task.create', 'Create a tracked multi-step task from an instruction.', 'tasks',
   '{"title":{"type":"string","required":true},"instruction":{"type":"string","required":true}}'::jsonb,
   'write', null, false, true),

  ('task.update', 'Update status or result of an existing task.', 'tasks',
   '{"task_id":{"type":"string","required":true},"status":{"type":"string"}}'::jsonb,
   'write', null, false, true),

  ('reminder.create', 'Schedule a one-time or recurring reminder.', 'reminders',
   '{"title":{"type":"string","required":true},"due_at":{"type":"string","required":true},"timezone":{"type":"string"},"rrule":{"type":"string"}}'::jsonb,
   'write', null, false, true),

  ('reminder.list', 'List upcoming and overdue reminders.', 'reminders',
   '{"limit":{"type":"integer"}}'::jsonb, 'read', null, false, true),

  ('reminder.cancel', 'Cancel a scheduled reminder.', 'reminders',
   '{"id":{"type":"string","required":true}}'::jsonb, 'high', null, true, true),

  ('wordpress.search', 'Search posts and pages on the connected WordPress site.',
   'wordpress', '{"query":{"type":"string","required":true},"limit":{"type":"integer"}}'::jsonb,
   'read', 'wordpress', false, true),

  ('wordpress.create_draft', 'Create a draft post on the connected WordPress site.',
   'wordpress',
   '{"title":{"type":"string","required":true},"content_html":{"type":"string","required":true},"excerpt":{"type":"string"},"categories":{"type":"array"}}'::jsonb,
   'write', 'wordpress', false, true),

  ('wordpress.update_post', 'Update an existing post or page.', 'wordpress',
   '{"post_id":{"type":"integer","required":true},"title":{"type":"string"},"content_html":{"type":"string"}}'::jsonb,
   'write', 'wordpress', false, true),

  ('wordpress.publish', 'Publish a draft post to the live site.', 'wordpress',
   '{"post_id":{"type":"integer","required":true}}'::jsonb, 'high', 'wordpress', true, true),

  ('wordpress.comments', 'List or moderate comments.', 'wordpress',
   '{"action":{"type":"string","enum":["list","approve","spam","trash"]},"post_id":{"type":"integer"}}'::jsonb,
   'write', 'wordpress', false, true),

  ('youtube.channel', 'Read channel metadata for the connected account.', 'youtube',
   '{}'::jsonb, 'read', 'youtube', false, true),

  ('youtube.videos', 'List or search the connected channel''s uploaded videos.', 'youtube',
   '{"query":{"type":"string"},"limit":{"type":"integer"}}'::jsonb, 'read', 'youtube', false, true),

  ('youtube.analytics', 'Retrieve views, watch time and subscriber deltas for a date range.',
   'youtube',
   '{"days":{"type":"integer","required":true}}'::jsonb, 'read', 'youtube', false, true),

  ('youtube.metadata_draft', 'Generate a title, description and tag set for an upcoming video.',
   'youtube',
   '{"topic":{"type":"string","required":true},"duration_minutes":{"type":"integer"}}'::jsonb,
   'write', 'youtube', false, true),

  ('youtube.upload', 'Upload a video file as private/draft when Data API scope allows.',
   'youtube',
   '{"path":{"type":"string","required":true},"title":{"type":"string","required":true},"privacy":{"type":"string","enum":["private","unlisted"]}}'::jsonb,
   'high', 'youtube', true, true),

  ('message.draft', 'Draft an email in the user''s preferred tone without sending it.',
   'messaging',
   '{"to":{"type":"string","required":true},"subject":{"type":"string","required":true},"body":{"type":"string","required":true},"tone":{"type":"string"}}'::jsonb,
   'write', 'gmail', false, true),

  ('message.send', 'Send an approved, already-reviewed message to a recipient.',
   'messaging',
   '{"draft_id":{"type":"string","required":true}}'::jsonb, 'high', 'gmail', true, true),

  ('web_search', 'Search the public web through the configured server-side provider.',
   'research', '{"query":{"type":"string","required":true},"num_results":{"type":"integer"}}'::jsonb,
   'read', 'serper', false, true),

  ('notes.create', 'Save a note into the personal knowledge base.', 'knowledge',
   '{"title":{"type":"string","required":true},"content":{"type":"string","required":true}}'::jsonb,
   'write', null, false, true),

  ('notify', 'Raise an in-app notification for the user.', 'system',
   '{"title":{"type":"string","required":true},"body":{"type":"string"}}'::jsonb, 'write', null, false, true)

on conflict (name) do update set
  description     = excluded.description,
  category        = excluded.category,
  input_schema    = excluded.input_schema,
  risk            = excluded.risk,
  requires_connection = excluded.requires_connection,
  requires_approval   = excluded.requires_approval,
  enabled         = excluded.enabled,
  updated_at      = now();
