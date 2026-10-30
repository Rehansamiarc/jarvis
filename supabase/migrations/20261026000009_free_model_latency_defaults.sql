-- =====================================================================================
-- JARVIS :: 000009 — latency-corrected Gemini defaults
-- =====================================================================================
-- Migration 000008 moved the platform defaults to Google's free tier, but picked the
-- model names from the catalogue instead of measuring them. Measured against the live
-- OpenAI-compatible shim (one-line prompt, 200-token cap):
--
--   gemini-3.5-flash-lite   1.9s   answered "JARVIS online"
--   gemini-3.1-flash-lite   2.0s   answered
--   gemini-3.5-flash        4.8s   answered
--   gemini-3.8-flash       82.0s   finish_reason=length, EMPTY content
--   gemini-3.7-flash      >100s    timed out
--   gemini-flash-latest       —    503 overloaded
--   gemini-2.5-flash          —    404 on the shim (served natively only)
--
-- So the seed pointed every conversational role at the slowest model available, which
-- also answers with empty content: chat looked like a hang and then failed with
-- "returned an empty response". This migration repoints those rows.
--
-- It only rewrites rows that still hold the previous platform default, so an account
-- that deliberately chose gemini-3.8-flash keeps that choice.
-- =====================================================================================

update public.model_config
set model = case role
              when 'coding'   then 'gemini-3.5-flash'
              when 'research' then 'gemini-3.5-flash'
              when 'vision'   then 'gemini-3.5-flash'
              -- primary, summary, speech: correctness matters, latency matters more —
              -- these are the roles that run inside a voice turn.
              else 'gemini-3.5-flash-lite'
            end,
    notes = case role
              when 'embedding' then notes
              when 'coding'   then 'Free Gemini Flash: code generation and review (measured 4.8s)'
              when 'research' then 'Free Gemini Flash: multi-step research / long context (measured 4.8s)'
              when 'vision'   then 'Free Gemini Flash: image understanding'
              when 'summary'  then 'Free Gemini Flash-Lite: cheap, fast summarisation (measured 1.9s)'
              when 'speech'   then 'Free Gemini Flash-Lite: voice turns need low latency (measured 1.9s)'
              else 'Free Gemini Flash-Lite: conversational default (measured 1.9s)'
            end,
    updated_at = now()
where user_id is null
  and provider = 'google'
  and role <> 'embedding'
  and model in ('gemini-3.8-flash', 'gemini-3.5-flash-lite');
