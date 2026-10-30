/**
 * Pure display formatters, shared by Server and Client Components.
 *
 * These live outside `components/ui.tsx` on purpose: that module is `"use client"`, and
 * React forbids calling a client-module function from a Server Component — importing
 * `formatWhen` there made every dashboard render throw. A function that only formats a
 * date has no client-only dependency, so it belongs in a neutral module that both
 * environments may call.
 */

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatWhen(iso: string | null | undefined, timezone = "UTC"): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}
