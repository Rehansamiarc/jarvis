"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAsyncEffect } from "@/hooks/useAsyncEffect";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Bell,
  Brain,
  CheckCircle2,
  CircleAlert,
  Database,
  Home,
  ListChecks,
  LogOut,
  MessageSquare,
  Plug,
  Settings,
  Timer,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { errorMessage, get, patch, post } from "@/lib/client/api";
import { timeAgo } from "@/components/ui";

interface NavItem {
  href: string;
  label: string;
  icon: typeof Home;
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Home", icon: Home },
  { href: "/chat", label: "Jarvis", icon: MessageSquare },
  { href: "/memory", label: "Memory", icon: Brain },
  { href: "/knowledge", label: "Knowledge", icon: Database },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/reminders", label: "Reminders", icon: Timer },
  { href: "/connections", label: "Files", icon: Plug },
  { href: "/activity", label: "Log", icon: Activity },
  { href: "/settings", label: "Setup", icon: Settings },
];

interface Notification {
  id: string;
  kind: string;
  level: string;
  title: string;
  body?: string | null;
  link?: string | null;
  created_at: string;
  read_at: string | null;
}

interface PendingAction {
  id: string;
  action_name: string;
  risk: string;
  title: string;
  preview: Record<string, unknown>;
  expires_at: string;
}

interface DashboardSlice {
  notifications: Notification[];
  pendingActions: PendingAction[];
  permissionMode: string;
  automationsPaused: boolean;
}

export default function AppShell({
  children,
  email,
}: {
  children: React.ReactNode;
  email: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [notifOpen, setNotifOpen] = useState(false);
  const [data, setData] = useState<DashboardSlice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const slice = await get<DashboardSlice>("/api/dashboard");
      setData(slice);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useAsyncEffect(refresh);

  // Keep the rail badges fresh while the console is open.
  useEffect(() => {
    const id = setInterval(refresh, 20_000);
    return () => clearInterval(id);
  }, [refresh]);

  // While JARVIS is open we run a user-scoped sweep so due reminders fire promptly.
  // This supplements cron; it is never the only mechanism — see Settings → Scheduling.
  useEffect(() => {
    let cancelled = false;
    const beat = async () => {
      if (cancelled) return;
      try {
        await post("/api/sweep");
      } catch {
        /* heartbeat is best-effort */
      }
    };
    const first = setTimeout(beat, 4_000);
    const id = setInterval(beat, 60_000);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  const unread = useMemo(
    () => (data?.notifications ?? []).filter((n) => !n.read_at).length,
    [data]
  );
  const pending = data?.pendingActions ?? [];

  async function decide(actionId: string, decision: "approve" | "deny") {
    setBusyAction(actionId);
    try {
      const result = await post<{ status: string; error?: string }>(`/api/actions/${actionId}`, {
        decision,
      });
      if (result.status === "failed") setError(result.error ?? "The action failed.");
      await refresh();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function markAllRead() {
    try {
      await patch("/api/notifications", { all: true });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function signOut() {
    await createClient().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  const busy = data?.automationsPaused;

  return (
    <div className="flex min-h-screen flex-col bg-black">
      {/* ------------------------------------------------------------- top strip */}
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-black/70 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[110rem] items-center gap-3 px-4 py-2.5 sm:px-6">
          <Link href="/dashboard" className="flex items-center gap-2.5" aria-label="JARVIS home">
            <span className="relative grid h-6 w-6 place-items-center">
              <span className="absolute inset-0 rounded-full bg-arc/25 blur-[6px]" />
              <span className="relative h-2 w-2 rounded-full bg-gold shadow-[0_0_12px_2px_rgba(255,154,60,0.85)]" />
            </span>
            <span className="hidden text-[0.72rem] font-medium uppercase tracking-[0.34em] text-ink/90 sm:block">
              Jarvis
            </span>
          </Link>

          {/* Centred tab strip — the video's three tiny tabs, extended to every surface. */}
          <nav className="tab-strip mx-auto max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {NAV.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`tab ${active ? "tab-active" : ""}`}
                >
                  {item.label}
                  {item.href === "/activity" && pending.length > 0 && (
                    <span className="ml-1.5 text-[0.6rem] text-gold">{pending.length}</span>
                  )}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-1.5">
            <span className="mr-1 hidden items-center gap-1.5 text-[0.62rem] uppercase tracking-[0.18em] text-faint lg:flex">
              <span className={`h-1 w-1 rounded-full ${busy ? "bg-gold" : "bg-ok"} status-pulse`} />
              {busy ? "paused" : "online"}
            </span>

            <div className="relative">
              <button
                className="relative rounded-full p-1.5 text-mute transition hover:bg-white/5 hover:text-ink"
                onClick={() => setNotifOpen((v) => !v)}
                aria-label="Notifications"
              >
                <Bell size={15} />
                {unread > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-arc px-1 text-[8px] font-bold text-black">
                    {unread > 9 ? "9+" : unread}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="enter absolute right-0 top-9 w-[min(92vw,22rem)] overflow-hidden rounded-xl border border-white/10 bg-[#0b0906]/95 shadow-2xl backdrop-blur-xl">
                  <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2">
                    <span className="label">Notifications</span>
                    {unread > 0 && (
                      <button onClick={markAllRead} className="text-[11px] text-arc hover:underline">
                        Mark all read
                      </button>
                    )}
                  </div>
                  <div className="max-h-80 overflow-y-auto">
                    {(data?.notifications ?? []).length === 0 && (
                      <p className="px-3 py-6 text-center text-sm text-faint">Nothing yet.</p>
                    )}
                    {(data?.notifications ?? []).map((n) => (
                      <Link
                        key={n.id}
                        href={n.link ?? "/activity"}
                        onClick={() => setNotifOpen(false)}
                        className={`block border-b border-white/[0.05] px-3 py-2.5 last:border-0 hover:bg-white/5 ${
                          n.read_at ? "opacity-55" : ""
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <span
                            className={`mt-1 h-1 w-1 shrink-0 rounded-full ${
                              n.level === "error"
                                ? "bg-danger"
                                : n.level === "warning"
                                  ? "bg-gold"
                                  : n.level === "success"
                                    ? "bg-ok"
                                    : "bg-arc"
                            }`}
                          />
                          <div className="min-w-0">
                            <div className="text-sm text-ink">{n.title}</div>
                            {n.body && (
                              <div className="mt-0.5 line-clamp-2 text-xs text-faint">{n.body}</div>
                            )}
                            <div className="mt-1 text-[10px] text-faint">{timeAgo(n.created_at)}</div>
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={signOut}
              className="rounded-full p-1.5 text-mute transition hover:bg-white/5 hover:text-ink"
              title={email}
              aria-label="Sign out"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>

        {error && (
          <div className="mx-auto flex max-w-[110rem] items-start gap-2 px-4 pb-2 text-[13px] text-[#ffb3a8] sm:px-6">
            <CircleAlert size={13} className="mt-1 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 opacity-60 hover:opacity-100">
              <X size={12} />
            </button>
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-[110rem] flex-1 px-4 py-5 sm:px-6 sm:py-7">{children}</main>

      {/* --------------------------------------- approval gate (macOS-style card) */}
      {pending.length > 0 && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center px-4">
          <div className="prompt-card enter pointer-events-auto w-full max-w-md p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-arc/15 text-arc">
                <CircleAlert size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold leading-tight text-white">
                  JARVIS wants to {pending[0].risk === "high" ? "perform" : "run"}{" "}
                  {pending[0].action_name}
                </div>
                <p className="mt-0.5 text-[12px] leading-snug text-mute">
                  {pending[0].title}
                  {pending.length > 1 && ` · ${pending.length - 1} more waiting`}
                </p>
              </div>
            </div>

            <ActionPreview preview={pending[0].preview} />

            <div className="mt-3.5 flex items-center gap-2">
              <Link href="/activity?view=approvals" className="btn btn-ghost h-8 py-0 text-[12px]">
                Details
              </Link>
              <div className="ml-auto flex gap-2">
                <button
                  className="btn btn-danger h-8 py-0 text-[12px]"
                  disabled={busyAction === pending[0].id}
                  onClick={() => decide(pending[0].id, "deny")}
                >
                  Deny
                </button>
                <button
                  className="btn btn-primary h-8 py-0 text-[12px]"
                  disabled={busyAction === pending[0].id}
                  onClick={() => decide(pending[0].id, "approve")}
                >
                  <CheckCircle2 size={12} /> Allow
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Renders the exact server-built preview so approval shows real parameters. */
function ActionPreview({ preview }: { preview: Record<string, unknown> }) {
  const entries = Object.entries(preview).filter(([k]) => k !== "action").slice(0, 6);
  if (!entries.length) return null;

  return (
    <dl className="mt-3 max-h-40 overflow-y-auto rounded-lg border border-white/[0.07] bg-black/40 px-2.5 py-2">
      {entries.map(([key, value]) => (
        <div key={key} className="grid grid-cols-[7rem_1fr] gap-2 py-0.5 text-[11px]">
          <dt className="truncate text-faint">{key}</dt>
          <dd className="min-w-0 break-words text-ink/90">
            {typeof value === "string"
              ? value.length > 300
                ? `${value.slice(0, 300)}…`
                : value
              : JSON.stringify(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
