-- =====================================================================================
-- JARVIS :: 000008 — free-tier model defaults
-- =====================================================================================
-- JARVIS must be usable without a credit card, so the platform default rows move to
-- Google's free Gemini tier:
--   * chat runs on Google's documented OpenAI-compatible shim
--     (https://generativelanguage.googleapis.com/v1beta/openai), which supports tool
--     calling and JSON output exactly like every other provider here;
--   * embeddings run on the native embedContent endpoint, because Google ships no
--     OpenAI-compatible /embeddings — and it is the only path that accepts an explicit
--     output dimension. 1536 is one of the sizes Google recommends, so it matches the
--     vector(1536) columns written by migration 000003.
--
-- This is platform configuration, not user data: per-account rows in model_config still
-- win, and the server appends every provider you actually hold a key for as an automatic
-- fallback (src/lib/ai/providers.ts), so adding OPENAI_API_KEY or GROQ_API_KEY later
-- changes the chain without another migration.
-- =====================================================================================

update public.model_config
set provider = 'google',
    base_url = case
                 when role = 'embedding' then null  -- embeddings use the native endpoint
                 else 'https://generativelanguage.googleapis.com/v1beta/openai'
               end,
    model = case
              when role = 'summary'   then 'gemini-3.5-flash-lite'
              when role = 'embedding' then 'gemini-embedding-001'
              else 'gemini-3.8-flash'
            end,
    notes = case
              when role = 'embedding'
                then 'Free Google embeddings via native embedContent, 1536-d (matches vector columns)'
              when role = 'summary'
                then 'Free Gemini Flash-Lite: cheap, fast summarisation'
              else 'Free Gemini Flash: ' || role || ' (Google free tier)'
            end,
    updated_at = now()
where user_id is null;

-- Rows the user has not touched keep following the platform defaults; rows the user
-- edited keep their choice because `where user_id is null` only touches the global rows.
