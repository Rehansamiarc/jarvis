"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Loader2, Mail, Lock } from "lucide-react";
import SparkOrb from "@/components/SparkOrb";

/**
 * Sign-in. Supports password and passwordless magic link; both resolve through
 * /auth/callback so there is exactly one place that creates a session.
 */
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<"password" | "magic">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.get("error"));
  const [sent, setSent] = useState(false);

  const next = params.get("next") || "/dashboard";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const supabase = createClient();

      if (mode === "password") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw new Error(humanise(error.message));
        router.replace(next);
        router.refresh();
        return;
      }

      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (error) throw new Error(humanise(error.message));
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="panel p-7 text-center">
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-full border border-arc/40 bg-arc/10 text-arc">
          <Mail size={20} />
        </span>
        <h2 className="mt-4 text-base font-semibold text-white">Check your inbox</h2>
        <p className="mt-2 text-sm text-mute">
          A sign-in link is on its way to <span className="text-ink">{email}</span>. Open it on this
          device to continue.
        </p>
        <button className="btn btn-ghost mt-5" onClick={() => setSent(false)}>
          Use a different address
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="panel p-7">
      <div className="mb-5 flex items-center justify-between">
        <span className="label">Sign in</span>
        <div className="flex rounded-lg border border-line p-0.5 text-xs">
          {(["password", "magic"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md px-2.5 py-1 transition ${
                mode === m ? "bg-arc/15 text-arc" : "text-mute hover:text-ink"
              }`}
            >
              {m === "password" ? "Password" : "Email link"}
            </button>
          ))}
        </div>
      </div>

      <label className="label mb-1.5 block">Email</label>
      <div className="relative mb-4">
        <Mail size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
        <input
          type="email"
          required
          autoComplete="email"
          className="input pl-9"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      {mode === "password" && (
        <>
          <label className="label mb-1.5 block">Password</label>
          <div className="relative mb-5">
            <Lock size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <input
              type="password"
              required
              autoComplete="current-password"
              className="input pl-9"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#ffb9c6]">
          {error}
        </div>
      )}

      <button type="submit" disabled={busy} className="btn btn-primary w-full">
        {busy && <Loader2 size={15} className="animate-spin" />}
        {mode === "password" ? "Sign in" : "Send sign-in link"}
      </button>

      <p className="mt-4 text-center text-xs text-faint">
        First time? The same form creates your account — Supabase sends a confirmation email on
        first sign-up.
      </p>
    </form>
  );
}

function humanise(message: string): string {
  if (/invalid login credentials/i.test(message)) return "That email and password combination did not match.";
  if (/email not confirmed/i.test(message)) return "Confirm your email first — check your inbox.";
  if (/rate limit/i.test(message)) return "Too many attempts. Wait a minute and try again.";
  if (/fetch failed|network/i.test(message))
    return "Could not reach the authentication service. Check NEXT_PUBLIC_SUPABASE_URL.";
  return message;
}

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-8">
      {/* Boot screen: the spark wakes up, then asks for a session. */}
      <div className="relative mx-auto -mb-2 h-[clamp(220px,34vh,320px)] w-full max-w-[380px]">
        <SparkOrb state="idle" />
      </div>
      <div className="mb-7 text-center">
        <h1 className="text-[0.72rem] font-medium uppercase tracking-[0.52em] text-ink">Jarvis</h1>
        <p className="mt-2 text-xs leading-relaxed text-mute">
          Your personal AI operating system — memory, tools, and audited actions.
        </p>
      </div>

      <Suspense fallback={<div className="panel h-72" />}>
        <LoginForm />
      </Suspense>

      <p className="mt-6 text-center text-xs text-faint leading-relaxed">
        Sessions are issued by Supabase Auth. Every record is protected by Row Level Security —
        your data is only ever visible to your account.
      </p>
    </main>
  );
}
