"use client";

import { useCallback, useEffect, useState, Suspense } from "react";
import { useAsyncEffect } from "@/hooks/useAsyncEffect";
import { useSearchParams } from "next/navigation";
import { Download, Loader2, Save, Trash2 } from "lucide-react";
import { errorMessage, get, patch } from "@/lib/client/api";
import { Badge, ErrorNote, PageHeader } from "@/components/ui";

interface Prefs {
  personality: string;
  voice_enabled: boolean;
  voice_name: string | null;
  speech_rate: number;
  speech_pitch: number;
  language: string;
  wake_word_enabled: boolean;
  permission_mode: "read_only" | "auto_low_risk" | "auto_approved" | "ask_everything";
  notify_in_app: boolean;
  notify_email: boolean;
  digest_hour: number;
  automations_paused: boolean;
  retention_days: number;
}

interface Profile {
  email: string;
  full_name: string | null;
  timezone: string;
}

const MODES: Array<{ value: Prefs["permission_mode"]; title: string; blurb: string }> = [
  {
    value: "read_only",
    title: "Read-only",
    blurb: "JARVIS may search, read and answer. Nothing is ever written or sent.",
  },
  {
    value: "auto_low_risk",
    title: "Auto low-risk",
    blurb: "Reads and reversible writes (drafts, notes, reminders) run immediately. Consequential actions ask.",
  },
  {
    value: "auto_approved",
    title: "Auto approved",
    blurb: "Everything reversible runs; publish, send, delete and upload still ask first.",
  },
  {
    value: "ask_everything",
    title: "Ask everything",
    blurb: "Every side effect waits for an explicit confirmation, including drafts.",
  },
];

function SettingsInner() {
  const params = useSearchParams();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [error, setError] = useState<string | null>(params.get("error"));
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await get<{ preferences: Prefs | null; profile: Profile | null }>("/api/preferences");
      setPrefs(res.preferences);
      setProfile(res.profile);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useAsyncEffect(load);

  useEffect(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      const read = () => setVoices(window.speechSynthesis.getVoices());
      read();
      window.speechSynthesis.onvoiceschanged = read;
      return () => {
        window.speechSynthesis.onvoiceschanged = null;
      };
    }
  }, [load]);

  async function save(patchBody: Partial<Prefs> & { timezone?: string; full_name?: string | null }) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await patch<{ preferences: Prefs }>("/api/preferences", patchBody);
      setPrefs(res.preferences);
      setNotice("Saved.");
      setTimeout(() => setNotice(null), 2500);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function exportData() {
    setExporting(true);
    try {
      const res = await fetch("/api/export");
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `jarvis-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  async function eraseAll() {
    const typed = prompt(
      'This permanently deletes all JARVIS data for your account (conversations, memories, knowledge, tasks, reminders, logs, credentials).\n\nType DELETE MY JARVIS DATA to confirm.'
    );
    if (typed !== "DELETE MY JARVIS DATA") {
      if (typed !== null) setError("Confirmation text did not match — nothing was deleted.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/export", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE MY JARVIS DATA" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setNotice(`Erased. Removed rows: ${Object.values(json.erased as Record<string, number>).reduce((a, b) => a + b, 0)}.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!prefs) {
    return <div className="text-sm text-mute">{error ?? "Loading settings…"}</div>;
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Personality, voice, permissions, notifications and data control. Permission changes take effect on the next request."
        actions={
          <button className="btn btn-ghost" onClick={() => void load()}>
            Reload
          </button>
        }
      />

      <ErrorNote message={error} />
      {notice && (
        <div className="mb-4 rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">{notice}</div>
      )}

      {/* --------------------------------------------------------- permissions */}
      <section className="mb-6">
        <div className="mb-3 flex items-center gap-3">
          <h2 className="label">Permissions</h2>
          <Badge tone="info">{prefs.permission_mode}</Badge>
          <button
            className="btn btn-ghost ml-auto h-8 py-0 text-xs"
            onClick={() => void save({ automations_paused: !prefs.automations_paused })}
            disabled={busy}
          >
            {prefs.automations_paused ? "Resume automations" : "Pause automations"}
          </button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => void save({ permission_mode: m.value })}
              className={`panel px-4 py-3 text-left transition ${
                prefs.permission_mode === m.value ? "panel-glow border-arc/50" : "hover:border-line2"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`h-3 w-3 rounded-full border ${
                    prefs.permission_mode === m.value ? "border-arc bg-arc" : "border-line2"
                  }`}
                />
                <span className="text-sm font-semibold text-white">{m.title}</span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-mute">{m.blurb}</p>
            </button>
          ))}
        </div>

        <p className="mt-2 text-xs text-faint">
          Publishing, sending, deleting and uploading always require confirmation regardless of mode —
          the check runs server-side, independently of the model.
        </p>
      </section>

      {/* ----------------------------------------------------------- personality */}
      <section className="mb-6">
        <h2 className="label mb-3">Personality</h2>
        <div className="panel p-4">
          <textarea
            className="input"
            rows={3}
            value={prefs.personality}
            onChange={(e) => setPrefs({ ...prefs, personality: e.target.value })}
            placeholder="How should JARVIS sound?"
          />
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <input
              className="input"
              placeholder="Your name"
              defaultValue={profile?.full_name ?? ""}
              onBlur={(e) => void save({ full_name: e.target.value || null })}
            />
            <select
              className="input"
              value={profile?.timezone ?? "UTC"}
              onChange={(e) => void save({ timezone: e.target.value })}
            >
              {Intl.supportedValuesOf("timeZone").map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
            <input
              className="input"
              placeholder="Language, e.g. en-US"
              value={prefs.language}
              onChange={(e) => setPrefs({ ...prefs, language: e.target.value })}
            />
          </div>
          <button className="btn btn-primary mt-3" onClick={() => void save({ personality: prefs.personality })} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save personality
          </button>
        </div>
      </section>

      {/* ---------------------------------------------------------------- voice */}
      <section className="mb-6">
        <h2 className="label mb-3">Voice</h2>
        <div className="panel p-4">
          <div className="mb-3 rounded-lg border border-line bg-void/50 px-3 py-2 text-xs text-mute">
            <strong className="text-ink">Honest scope:</strong> JARVIS listens only while voice mode is
            active in this tab. The browser cannot listen in the background, and the wake word works
            only during an active session with the tab visible. Speech synthesis (voice output) works
            whenever you ask for it.
          </div>

          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={prefs.voice_enabled}
              onChange={(e) => void save({ voice_enabled: e.target.checked })}
            />
            Enable voice output by default
          </label>

          <label className="mt-2 flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={prefs.wake_word_enabled}
              onChange={(e) => void save({ wake_word_enabled: e.target.checked })}
            />
            Require the wake word “JARVIS” while voice mode is active
          </label>

          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-faint">
              Speed
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                className="mt-1 w-full accent-[#35e0ff]"
                value={prefs.speech_rate}
                onChange={(e) => setPrefs({ ...prefs, speech_rate: Number(e.target.value) })}
                onMouseUp={() => void save({ speech_rate: prefs.speech_rate })}
                onTouchEnd={() => void save({ speech_rate: prefs.speech_rate })}
              />
              {prefs.speech_rate.toFixed(2)}×
            </label>
            <label className="text-xs text-faint">
              Pitch
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                className="mt-1 w-full accent-[#35e0ff]"
                value={prefs.speech_pitch}
                onChange={(e) => setPrefs({ ...prefs, speech_pitch: Number(e.target.value) })}
                onMouseUp={() => void save({ speech_pitch: prefs.speech_pitch })}
                onTouchEnd={() => void save({ speech_pitch: prefs.speech_pitch })}
              />
              {prefs.speech_pitch.toFixed(2)}
            </label>
            <label className="text-xs text-faint">
              Voice
              <select
                className="input mt-1"
                value={prefs.voice_name ?? ""}
                onChange={(e) => void save({ voice_name: e.target.value || null })}
              >
                <option value="">System default</option>
                {voices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
              {voices.length === 0 && (
                <span className="mt-1 block text-[11px] text-gold">
                  No voices reported yet — voice input also requires Chrome/Edge.
                </span>
              )}
            </label>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- notifications */}
      <section className="mb-6">
        <h2 className="label mb-3">Notifications & scheduling</h2>
        <div className="panel space-y-3 p-4">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={prefs.notify_in_app}
              onChange={(e) => void save({ notify_in_app: e.target.checked })}
            />
            In-app notifications
          </label>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={prefs.notify_email}
              onChange={(e) => void save({ notify_email: e.target.checked })}
            />
            Email a copy of reminders (requires RESEND_API_KEY)
          </label>
          <label className="flex items-center gap-2 text-sm text-ink">
            Daily briefing hour:
            <input
              type="number"
              min={0}
              max={23}
              className="input w-20"
              value={prefs.digest_hour}
              onBlur={(e) => void save({ digest_hour: Number(e.target.value) })}
            />
            <span className="text-xs text-faint">in {profile?.timezone ?? "UTC"}</span>
          </label>
          <label className="flex items-center gap-2 text-sm text-ink">
            Audit/log retention:
            <input
              type="number"
              min={30}
              max={3650}
              className="input w-24"
              value={prefs.retention_days}
              onBlur={(e) => void save({ retention_days: Number(e.target.value) })}
            />
            <span className="text-xs text-faint">days</span>
          </label>

          <div className="rounded-lg border border-line bg-void/50 px-3 py-2 text-xs text-faint">
            Cron runs <code className="text-arc">/api/cron/reminders</code>,{" "}
            <code className="text-arc">/api/cron/jobs</code> and{" "}
            <code className="text-arc">/api/cron/digest</code> with{" "}
            <code className="text-arc">CRON_SECRET</code>. On Vercel&apos;s Hobby plan the minimum
            cron interval is one day, so an open tab additionally runs a user-scoped sweep every
            minute — and every sweep catches up anything overdue.
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- data */}
      <section className="mb-6">
        <h2 className="label mb-3">Your data</h2>
        <div className="panel flex flex-wrap items-center gap-3 p-4">
          <button className="btn btn-ghost" onClick={exportData} disabled={exporting}>
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Export everything
          </button>
          <button className="btn btn-danger" onClick={eraseAll} disabled={busy}>
            <Trash2 size={14} /> Delete all data
          </button>
          <p className="text-xs text-faint">
            Export produces one JSON file containing every row JARVIS holds for you. Deletion is
            irreversible and requires typing the confirmation phrase.
          </p>
        </div>
      </section>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-mute">Loading settings…</div>}>
      <SettingsInner />
    </Suspense>
  );
}
