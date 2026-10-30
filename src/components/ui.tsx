"use client";

import type { ReactNode } from "react";

export function Card({
  children,
  className = "",
  as: Tag = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
}) {
  return <Tag className={`panel ${className}`}>{children}</Tag>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-white">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-mute">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "danger" | "info";
}) {
  const tones: Record<string, string> = {
    neutral: "border-line2 text-mute",
    ok: "border-ok/40 bg-ok/10 text-ok",
    warn: "border-gold/40 bg-gold/10 text-gold",
    danger: "border-danger/40 bg-danger/10 text-[#ffb9c6]",
    info: "border-arc/40 bg-arc/10 text-arc",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-mute">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line2 border-t-arc" />
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="panel flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 h-9 w-9 rounded-full border border-dashed border-line2" />
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="mt-1.5 max-w-md text-sm text-faint">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#ffb9c6]">
      {message}
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="panel px-4 py-3">
      <div className="label">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone ?? "text-white"}`}>{value}</div>
    </div>
  );
}

// The date formatters are defined in a neutral module so Server Components may call
// them too; re-exported here for the client components that already import from `ui`.
export { formatWhen, timeAgo } from "@/lib/format";
