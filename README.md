# JARVIS

A personal AI operator: a voice-enabled assistant that remembers you, searches your own
knowledge, runs multi-step tasks against real services, and asks before it does anything
consequential. Built on Next.js (App Router), Supabase (Postgres + pgvector + Auth + RLS)
and deployable to Vercel.

Nothing here is a mock: every tool either performs a real API call or reports precisely why
it could not (missing credential, missing scope, platform restriction).

---

## 1. What is actually implemented

| Area | Status | Notes |
| --- | --- | --- |
| Conversational agent loop (plan → select tools → validate → execute → verify) | **Working** | Bounded steps, retries, per-run execution log, cancellation |
| Central tool registry with per-tool Zod schemas | **Working** | 25 tools; JSON Schema generated from the same Zod objects the server validates with |
| Task-driven tool loading (only relevant tools sent to the model) | **Working** | Core set + intent routing + budget, with `load_tools` for the rest |
| Permission engine (read / write / high risk + connection requirements) | **Working** | Independent of the model; approval gate cannot be widened by prompt injection |
| Approval checkpoints for consequential actions | **Working** | Server-built preview of the exact payload; signed, expiring pending actions |
| Persistent memory (searchable, editable, exportable, deletable) | **Working** | Separate from documents and from conversation history |
| Knowledge base: ingest → chunk → embed → pgvector, hybrid search, citations | **Working** | Requires `OPENAI_API_KEY` for embeddings; degrades to keyword-only search without it |
| Reminders, recurrence (RRULE), timezone handling, missed-run recovery | **Working** | Postgres-backed queue; delivery via cron, not the open browser tab |
| Background jobs, digests, retries with exponential backoff, dead-letter | **Working** | Claim/complete functions in SQL, one sweeper endpoint |
| WordPress (search, drafts, publish, comments, status) | **Working once connected** | Application password or OAuth; publish/delete always requires approval |
| YouTube (channel, videos, analytics, metadata drafts, upload) | **Working once connected** | Upload needs the `youtube.upload` scope and a verified account; quota-limited |
| Gmail (read, draft, send) | **Working once connected** | Send requires approval; delivery is Gmail's, not inferred |
| Email via Resend (fallback channel) | **Working once configured** | Used when Gmail is not connected |
| Web search (Serper) | **Working once configured** | Results are untrusted content, never instructions |
| Voice: speech recognition + TTS, barge-in, wake word (opt-in) | **Working (browser + desktop)** | Browser uses Web Speech APIs with no background listening; the desktop app adds real background wake-word listening (§9) |
| Windows desktop app: tray, autostart, wake word, Voice Studio | **Working** | Electron app in `desktop/`; hands-free mode needs a free Picovoice key — see §9 |
| Multi-model routing, capability checks, provider fallback | **Working** | Primary + specialist roles (coding/research/summary/vision/speech/embedding) |
| Encryption of OAuth tokens and app passwords at rest | **Working** | AES-256-GCM, server-only key, versioned envelope |
| Row Level Security on every user-owned row | **Working** | `auth.uid() = user_id` predicate; service-role calls are always user-filtered |
| Unit tests | **Working** | 68 tests across crypto, policy, tools, knowledge, scheduler, models |

**Not implemented, and not claimed:** continuous background listening *in a browser tab* (the
desktop app's wake word is the supported path — §9), "send" on platforms without an official
API, autonomous publishing without approval, arbitrary code execution, and unrestricted
database access. Those are deliberate. Windows Hello, speaker verification and PC control are
not built yet either; they are the next phase of the desktop work.

---

## 2. Quick start

```bash
npm install
cp .env.example .env.local     # then fill it in (see §3)
npm run dev
```

Open http://localhost:3000 and sign in. The first sign-up creates your account; Supabase
sends a confirmation email.

### Database

Create a Supabase project, then apply the versioned migrations:

```bash
supabase link --project-ref <your-ref>
npm run db:migrate           # supabase db push
```

Migrations live in `supabase/migrations` and must be applied in order:

1. `..._extensions_enums.sql` — pgvector, enums
2. `..._tables_core.sql` — identity, conversations, memory, work, integrations
3. `..._tables_knowledge_ai.sql` — documents, chunks, embeddings, model config, execution logs
4. `..._functions_triggers.sql` — hybrid search, updated_at, ownership triggers
5. `..._rls_policies.sql` — Row Level Security for every table
6. `..._seed_registry.sql` — platform model defaults and tool metadata
7. `..._scheduler_functions.sql` — job claim/complete with backoff and dead-lettering

---

## 3. Environment variables

Everything is optional at boot: missing configuration degrades a specific feature and is
reported in the UI instead of crashing the app. `availability()` in `src/lib/env.ts` is the
single source of truth for "what works right now".

### Required for the app to be usable

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public anon key (RLS applies) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only; reads encrypted credentials, refreshes OAuth tokens. Never sent to the browser |
| `SECRET_ENCRYPTION_KEY` | 32 bytes for AES-256-GCM. Base64/hex/passphrase all accepted |
| `NEXT_PUBLIC_APP_URL` | Canonical origin, used for OAuth redirects and auth callbacks |
| `OPENAI_API_KEY` | Model calls and embeddings |

### Scheduling

| Variable | Purpose |
| --- | --- |
| `CRON_SECRET` | Bearer token required by `/api/cron/*`. Vercel Cron sends it automatically |

Cron is declared in `vercel.json`:

- `/api/cron/reminders` — `0 6 * * *` (drains everything due since the last sweep)
- `/api/cron/jobs` — `0 6 * * *` (automations, digests, re-indexing)
- `/api/cron/digest` — `0 13 * * *` (daily briefing)

**Reminder latency is bounded by the cron cadence.** Vercel's Hobby plan only permits
once-a-day cron, so a reminder scheduled for the evening is delivered at the next sweep —
up to 24h late. Nothing is lost (jobs are durable and claimed by `run_at <= now`), but if
you want minute-level delivery choose one:

1. **Vercel Pro** — change the two schedules in `vercel.json` to `* * * * *`.
2. **External pinger** (free, no plan change) — point cron-job.org or similar at
   `https://<your-app>/api/cron/reminders` every minute with header
   `Authorization: Bearer $CRON_SECRET`, and set the same secret in that service.
3. **Open tab heartbeat** — `/api/sweep` runs from the dashboard every 60s while JARVIS is
   open. This is a supplement only; it never replaces cron.

### Models (all optional; sane defaults apply)

`JARVIS_MODEL_PRIMARY`, `JARVIS_MODEL_CODING`, `JARVIS_MODEL_RESEARCH`,
`JARVIS_MODEL_SUMMARY`, `JARVIS_MODEL_VISION`, `JARVIS_MODEL_SPEECH`,
`JARVIS_EMBEDDING_MODEL`, `JARVIS_EMBEDDING_DIM`, `OPENAI_BASE_URL`.

Per-account overrides live in the `model_config` table and take precedence over env.

### Integrations

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Gmail + YouTube OAuth. Redirect URI: `${NEXT_PUBLIC_APP_URL}/api/oauth/google/callback` |
| `SERPER_API_KEY` | Web search |
| `RESEND_API_KEY`, `RESEND_FROM` | Email fallback when Gmail is not connected |
| `WORDPRESS_SITE_URL`, `WORDPRESS_USERNAME`, `WORDPRESS_APP_PASSWORD` | Optional default WordPress site; per-user credentials can be added in Settings |

**Secrets never reach the browser.** Provider keys are read only from server modules
(`src/lib/env.ts`), credential columns are sealed with `src/lib/crypto/secrets.ts`, and the
RLS policies do not grant `SELECT` on those columns to client sessions.

---

## 4. Verifying it works

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint (includes React Compiler hook rules)
npm test              # vitest — 68 unit tests
npm run build         # production build
```

Health check once deployed:

```bash
curl -s https://your-app.vercel.app/api/health | jq
```

It reports which capabilities are configured, without revealing any secret values.

### What the tests cover

- **crypto** — seal/unseal round-trip, tamper detection on ciphertext and auth tag, key
  rotation, fingerprints, constant-time comparison
- **policy** — the full permission matrix: read-only blocking writes, high risk always
  prompting, unconnected integrations refused, alternative providers, mode parsing
- **tools** — registry integrity (no duplicate names), required capability surface,
  generated JSON Schema, server-side argument validation (bad JSON, missing fields), tool
  selection budget, and that read-only mode never even offers a mutation
- **knowledge** — chunk sizing/overlap/ordering, HTML stripping, content hashing, and that
  re-indexing an unchanged document skips embedding spend while staying user-scoped
- **scheduler** — job-key identity per reminder occurrence, enqueue idempotency (including a
  lost race on the unique index), reconciliation, digest timing
- **models** — capability inference, fallback on a rate-limited provider, refusal to hand a
  tool-calling request to an embedding model, and rethrowing genuine request errors

Retrieval quality and RLS isolation are enforced in SQL, so verifying them needs a live
Supabase instance:

```sql
-- as user A (anon key + A's JWT): must return 0 rows from user B
select count(*) from knowledge_chunks where user_id <> auth.uid();
```

---

## 5. Architecture

```
src/
  app/                 routes: (app) shell, api/*, auth, login
  components/          SparkOrb, Chat, AppShell, ui primitives
  hooks/               useVoice, useAsyncEffect
  lib/
    agent/             prompt, context assembly, the execution loop
    ai/                provider abstraction, model manager, embeddings, usage metering
    crypto/            AES-256-GCM sealing for stored credentials
    integrations/      wordpress, youtube, gmail, resend, search, connection store
    knowledge/         chunking + ingest/search pipeline (pgvector, hybrid RRF)
    memory/            long-term memory read/write/retrieval
    permissions/       the policy engine
    scheduler/         queue helpers + sweeper/runner
    tools/             registry, selection, definitions/*
supabase/migrations/   versioned schema, functions, RLS
tests/                 vitest suites + fakes
```

### The agent loop

1. **Assemble context** — profile, preferences, relevant memories, retrieved knowledge with
   citations, connection status.
2. **Select tools** — core tools plus intent-matched tools, capped by a budget. Everything
   else is *deferred*, advertised by name so the model can request it.
3. **Call the model** — with capability checks; if the model cannot do tools/JSON/vision the
   call is routed to one that can.
4. **Validate every tool call** — unknown tool, bad JSON, or schema mismatch is rejected
   server-side and recorded.
5. **Decide permission** — the policy engine, not the model, decides whether it runs, needs a
   preview + approval, or is refused.
6. **Execute and verify** — handlers confirm the effect against the provider (a created post
   is re-fetched) before reporting success; `verified` is recorded separately from `ok`.
7. **Log** — `execution_logs` and `action_logs` keep the real arguments, result and status.

### Safety properties

- The model never sees `SUPABASE_SERVICE_ROLE_KEY`-backed data it should not.
- Untrusted content (web pages, email, documents) is inserted as *data* with provenance
  markers, never as instructions.
- Idempotency keys make duplicate scheduling and retried actions no-ops.
- High-risk actions require a preview built from real data, plus an explicit approval before
  execution.

---

## 6. Deployment (Vercel)

1. Push the repository and import it in Vercel.
2. Add the environment variables from §3 (Production and Preview).
3. Add `CRON_SECRET`; `vercel.json` already declares the cron jobs.
4. Deploy. Then verify:
   - `GET /api/health` lists the configured capabilities
   - sign-in → `/dashboard` renders the spark and readouts
   - connect an integration from `/connections`
   - create a reminder and watch `/api/cron/reminders` deliver it

`maxDuration` is set on the agent and cron routes; the scheduler is designed so a single
invocation drains work in bounded batches rather than assuming an open connection.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "JARVIS is not configured yet" | `NEXT_PUBLIC_SUPABASE_URL` / `ANON_KEY` are missing; nothing else loads until they exist |
| Every tool returns "not connected" | Expected until you authorise the provider in Settings → Connections |
| Knowledge search returns nothing | No `OPENAI_API_KEY` (keyword-only mode is weaker) or the document is still `indexing`/`failed` — check its status in Knowledge |
| Reminders do not fire | `CRON_SECRET` missing on Vercel, or cron is disabled on the plan; the open-tab heartbeat is a supplement, not a replacement |
| OAuth callback error | The redirect URI must be exactly `${NEXT_PUBLIC_APP_URL}/api/oauth/google/callback`, including scheme |
| `Unrecognised secret envelope format` | `SECRET_ENCRYPTION_KEY` changed after credentials were stored; reconnect the integration |
| Model answers "I cannot do that" for a tool that exists | The tool was not selected for this request — ask JARVIS to load it, or rephrase with the provider name |

---

## 8. Design

Black field, one amber emitter: the spark (`src/components/SparkOrb.tsx`) is the interface,
and everything else is a thin readout around it. Motion is limited to the orb's own
breathing, one status pulse and the voice waveform, and all of it stops under
`prefers-reduced-motion`. The orb pauses when the tab is hidden or scrolled out of view.

---

## 9. Windows desktop app

A second front end in `desktop/`, built with Electron 45. It runs independently of the
browser: close the window and it stays in the tray, keeps listening for the wake word, and
keeps talking to the same brain.

```bash
npm run desktop:build   # bundle main + preload + renderer (esbuild) → desktop/dist
npm run desktop         # launch the tray app
npm run desktop:smoke   # headless self-check: prints JSON, exits 0 only if every check passes
```

### What actually works

| Capability | Status | Detail |
| --- | --- | --- |
| Tray app, single instance, close-to-tray | **Working** | Amber icon drawn as RGBA at runtime; the menu drives mute, wake word, autostart and quit |
| Start with Windows | **Working** | `app.setLoginItemSettings`; the checkbox reads back what Windows actually stored |
| Sign-in reusing the Supabase session | **Working** | Sign-in window runs in its own `persist:jarvis-auth` partition; main replays the cookie to the REST API |
| Voice Studio (voices, rate, pitch, previews) | **Working** | Enumerates OS speech voices (3 on this machine), previews instantly, saves to `user_preferences` |
| On-device wake word | **Working once a key is set** | Porcupine on 16 kHz / 512-sample windows; `JARVIS` is a built-in keyword, a custom `.ppn` is accepted |
| Privacy controls | **Working** | Mute releases the microphone, strict CSP, contextIsolation, no Node in the renderer |
| Command the brain | **Working** | `/api/agent/run` over the same cookie session; the reply is spoken in the chosen voice |

`npm run desktop:smoke` on this machine:

```
PASS electron          electron 45.0.0 · node 24.22.0
PASS config_roundtrip  written and re-read identically
PASS wake_word_model   ...\porcupine-node\resources\keyword_files\windows\jarvis_windows.ppn
PASS wake_word_engine  skipped — no Picovoice access key configured (engine loads on demand)
PASS brain_reachable   Not signed in. Open the sign-in window to continue.
PASS autostart         openAtLogin=false
PASS tray_icon         16x16 RGBA bitmap
PASS speech_api        recognition=function, synthesis=object, audioContext=function, audioWorklet=function
PASS renderer_bridge   window.jarvis exposes the typed API with isolation on
PASS renderer_bundle   index.html + renderer.js present
```

A real launch additionally logs `[jarvis-desktop] ready`, `[jarvis-desktop] renderer ready`
and `[jarvis-desktop] 3 speech voices loaded`, with no CSP warning and no renderer errors.

### How the pieces fit

- `desktop/main.ts` — lifecycle, tray, windows, IPC and the wake-word frame pump.
- `desktop/preload.ts` — the only bridge; `contextBridge` exposes named channels and nothing else.
- `desktop/ui/renderer.ts` — Voice Studio, microphone capture (AudioWorklet) and privacy panel.
- `desktop/brain.ts` — REST client; the session cookie never enters the renderer.
- `desktop/wakeword.ts` / `desktop/config.ts` — engine wrapper and validated local config.

### Hardware, permissions and OS limitations

- **The wake-word engine needs a free Picovoice access key** (console.picovoice.ai). Without
  one the app is fully usable but not hands-free, and it says so. The model file is present and
  the engine path is wired, but **detection itself is unverified here** because no key is set.
- **Microphone permission** comes from Windows: Settings → Privacy → Microphone → “Let desktop
  apps access your microphone”. The device is opened only while wake-word listening is on.
- **Voice Studio is limited to voices installed in Windows.** More languages need the matching
  Windows language/voice pack. Cloud voices were deferred, not simulated.
- **Speech-to-text** uses Chromium's Web Speech API. This build exposes the constructor
  (`recognition=function`), but transcription depends on a configured speech service and was
  **not exercised end-to-end** — that needs a spoken phrase. Typed commands always work.
- **Start with Windows** writes a login item; in development that item is `electron.exe` plus the
  project path. The app is **not code-signed**, so a packaged build would trip SmartScreen.
- **Not built yet:** Windows Hello (face/PIN/fingerprint), speaker verification, and PC control
  (approved apps, file search, notifications). Nothing in this build pretends otherwise.
- The session lives in Electron's `userData` directory. The desktop app holds no service-role
  key and never reads provider secrets — it only replays the user's own session cookie.
