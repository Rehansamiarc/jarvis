"use client";

import { useCallback, useState } from "react";
import { useAsyncEffect } from "@/hooks/useAsyncEffect";
import { AlertTriangle, ExternalLink, Loader2, Plug, ShieldCheck, Unplug } from "lucide-react";
import { errorMessage, get, post } from "@/lib/client/api";
import { Badge, ErrorNote, PageHeader } from "@/components/ui";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

interface ConnectionData {
  connections: Record<string, string>;
  integrations: Array<{
    provider: string;
    status: string;
    config: Record<string, unknown>;
    granted_scopes: string[];
    connected_at: string | null;
    last_error: string | null;
  }>;
  oauth: Array<{
    provider: string;
    status: string;
    scopes: string[];
    expiresAt: string | null;
    account: string | null;
    lastRefreshedAt: string | null;
  }>;
  serverCapabilities: Record<string, boolean>;
  configuredEnv: Record<string, boolean>;
  googleRedirectUri: string;
}

interface Capability {
  key: string;
  name: string;
  blurb: string;
  scopes: string[];
  connectUrl?: string;
}

const GOOGLE_CONNECT = "/api/oauth/google?scope=all";
const GOOGLE_YOUTUBE_ONLY = "/api/oauth/google?scope=youtube";
const GOOGLE_GMAIL_ONLY = "/api/oauth/google?scope=gmail";

function ConnectionsInner() {
  const params = useSearchParams();
  const [data, setData] = useState<ConnectionData | null>(null);
  const [error, setError] = useState<string | null>(params.get("error"));
  const [notice, setNotice] = useState<string | null>(
    params.get("connected") ? "Google account connected." : null
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [wp, setWp] = useState({ siteUrl: "", username: "", appPassword: "" });

  const load = useCallback(async () => {
    try {
      setData(await get<ConnectionData>("/api/connections"));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useAsyncEffect(load);

  async function connectWordPress() {
    setBusy("wordpress");
    setError(null);
    setNotice(null);
    try {
      const res = await post<{ site: { name?: string } }>("/api/connections", {
        provider: "wordpress",
        ...wp,
      });
      setNotice(
        `WordPress validated and stored${res.site?.name ? ` — ${res.site.name}` : ""}. Credentials are encrypted server-side only.`
      );
      setWp({ siteUrl: "", username: "", appPassword: "" });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(provider: string) {
    if (!confirm(`Disconnect ${provider}? Stored credentials are wiped and OAuth tokens revoked.`))
      return;
    setBusy(provider);
    try {
      const res = await fetch(`/api/connections?provider=${provider}`, { method: "DELETE" });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setNotice(`${provider} disconnected.`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const capabilities: Capability[] = [
    {
      key: "youtube",
      name: "YouTube",
      blurb:
        "Channel info, uploads, keyword search and Analytics API reports. Reading uses ~1 unit per call; keyword search uses 100.",
      scopes: [
        "youtube.readonly — read channel + videos",
        "youtube.upload — required only for uploads",
        "youtube.force-ssl — required only for playlist edits",
      ],
      connectUrl: GOOGLE_YOUTUBE_ONLY,
    },
    {
      key: "gmail",
      name: "Gmail",
      blurb:
        "Draft and send email as you. Reading is only used to quote the message you reply to.",
      scopes: [
        "gmail.readonly — quote incoming messages",
        "gmail.compose — create drafts",
        "gmail.send — deliver an approved message",
      ],
      connectUrl: GOOGLE_GMAIL_ONLY,
    },
    {
      key: "google",
      name: "Google (full access)",
      blurb: "Connect both YouTube and Gmail in one step using the broadest scope set.",
      scopes: ["openid", "email", "profile", "youtube.*", "gmail.*"],
      connectUrl: GOOGLE_CONNECT,
    },
  ];

  const envNeeded = Object.entries(data?.configuredEnv ?? {})
    .filter(([, v]) => !v)
    .map(([k]) => k);

  return (
    <div>
      <PageHeader
        title="Connected accounts"
        subtitle="Every integration is authorised by you through an official OAuth or application-password flow. JARVIS stores no credentials in the browser, and requests only the scopes listed below."
        actions={
          <button className="btn btn-ghost" onClick={() => void load()}>
            Refresh
          </button>
        }
      />

      <ErrorNote message={error} />
      {notice && (
        <div className="mb-4 rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">
          {notice}
        </div>
      )}

      <div className="mb-5 rounded-xl border border-line bg-panel/70 p-4">
        <div className="mb-2 flex items-center gap-2">
          <ShieldCheck size={16} className="text-arc" />
          <span className="label">How credentials are handled</span>
        </div>
        <ul className="list-disc space-y-1 pl-5 text-sm text-mute">
          <li>OAuth refresh tokens and WordPress application passwords are sealed with AES-256-GCM before storage.</li>
          <li>Ciphertext columns are not even grantable to a signed-in client — only server routes can read them.</li>
          <li>Nothing is written to <code className="text-arc">localStorage</code>, cookies or the client bundle.</li>
          <li>Disconnecting wipes the ciphertext and revokes the Google grant.</li>
        </ul>
      </div>

      {envNeeded.length > 0 && (
        <div className="mb-4 rounded-lg border border-gold/40 bg-gold/10 px-3 py-2 text-sm text-gold">
          <div className="mb-1 flex items-center gap-2">
            <AlertTriangle size={14} /> Server configuration incomplete
          </div>
          <span className="text-xs">Missing: {envNeeded.join(", ")} — see .env.example.</span>
        </div>
      )}

      {/* -------------------------------------------------------------- Google */}
      <section className="mb-6">
        <h2 className="label mb-3">OAuth integrations</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {capabilities.map((c) => {
            const status = data?.connections?.[c.key] ?? "not_connected";
            const connected = status === "connected";
            const oauth = data?.oauth?.[0];
            return (
              <article key={c.key} className="panel flex flex-col p-4">
                <div className="mb-2 flex items-center gap-2">
                  <Plug size={15} className={connected ? "text-ok" : "text-faint"} />
                  <h3 className="text-sm font-semibold text-white">{c.name}</h3>
                  <span className="ml-auto">
                    <Badge tone={connected ? "ok" : status === "needs_reauth" ? "warn" : "neutral"}>
                      {connected ? "connected" : status === "needs_reauth" ? "re-auth needed" : "not connected"}
                    </Badge>
                  </span>
                </div>

                <p className="mb-3 flex-1 text-xs leading-relaxed text-mute">{c.blurb}</p>

                <ul className="mb-3 space-y-0.5 text-[11px] text-faint">
                  {c.scopes.map((s) => (
                    <li key={s}>· {s}</li>
                  ))}
                </ul>

                {connected && oauth && (
                  <div className="mb-3 text-[11px] text-faint">
                    {oauth.account && <div>account: {oauth.account}</div>}
                    {oauth.expiresAt && <div>token expires: {new Date(oauth.expiresAt).toLocaleString()}</div>}
                  </div>
                )}

                {c.connectUrl ? (
                  <a href={c.connectUrl} className="btn btn-primary w-full">
                    {connected ? "Reconnect" : "Connect"}
                    <ExternalLink size={13} />
                  </a>
                ) : null}

                {connected && (
                  <button
                    className="btn btn-danger mt-2 w-full"
                    onClick={() => disconnect(c.key)}
                    disabled={busy === c.key}
                  >
                    {busy === c.key ? <Loader2 size={13} className="animate-spin" /> : <Unplug size={13} />}
                    Disconnect
                  </button>
                )}
              </article>
            );
          })}
        </div>

        <p className="mt-2 text-xs text-faint">
          Redirect URI required by Google:{" "}
          <code className="text-arc">{data?.googleRedirectUri || "…"}</code>
        </p>
      </section>

      {/* ---------------------------------------------------------- WordPress */}
      <section>
        <h2 className="label mb-3">WordPress</h2>
        <div className="panel p-4">
          <div className="mb-3 flex items-center gap-2">
            <Badge tone={data?.connections?.wordpress === "connected" ? "ok" : "neutral"}>
              {data?.connections?.wordpress === "connected" ? "connected" : "not connected"}
            </Badge>
            <span className="text-xs text-faint">
              Create the password at WordPress → Users → Profile → Application Passwords.
            </span>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <input
              className="input"
              placeholder="https://example.com"
              value={wp.siteUrl}
              onChange={(e) => setWp({ ...wp, siteUrl: e.target.value })}
            />
            <input
              className="input"
              placeholder="username"
              value={wp.username}
              onChange={(e) => setWp({ ...wp, username: e.target.value })}
            />
            <input
              className="input"
              type="password"
              placeholder="xxxx xxxx xxxx xxxx"
              value={wp.appPassword}
              onChange={(e) => setWp({ ...wp, appPassword: e.target.value })}
            />
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="btn btn-primary"
              onClick={connectWordPress}
              disabled={busy === "wordpress" || !wp.siteUrl || !wp.username || !wp.appPassword}
            >
              {busy === "wordpress" && <Loader2 size={14} className="animate-spin" />}
              Validate & connect
            </button>
            {data?.connections?.wordpress === "connected" && (
              <button className="btn btn-danger" onClick={() => disconnect("wordpress")} disabled={busy === "wordpress"}>
                Disconnect
              </button>
            )}
          </div>

          <p className="mt-3 text-xs text-faint">
            JARVIS validates the connection against <code className="text-arc">/wp-json/</code> before
            saving. Drafts are the default; publishing always asks for confirmation.
          </p>
        </div>
      </section>

      <section className="mt-6">
        <h2 className="label mb-3">Server-side providers</h2>
        <div className="panel grid gap-2 p-4 text-sm sm:grid-cols-3">
          {[
            { key: "serper", label: "Web search (SERPER_API_KEY)" },
            { key: "resend", label: "Email fallback (RESEND_API_KEY)" },
            { key: "serviceRole", label: "Service role (SUPABASE_SERVICE_ROLE_KEY)" },
          ].map((p) => (
            <div key={p.key} className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
              <span className="text-xs text-mute">{p.label}</span>
              <Badge tone={data?.configuredEnv?.[p.key] ? "ok" : "warn"}>
                {data?.configuredEnv?.[p.key] ? "set" : "unset"}
              </Badge>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default function ConnectionsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-mute">Loading connections…</div>}>
      <ConnectionsInner />
    </Suspense>
  );
}
