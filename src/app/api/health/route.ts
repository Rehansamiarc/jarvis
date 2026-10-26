import { NextResponse } from "next/server";
import { availability, env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Health check (section 14).
 *
 * Reports *configuration* and *reachability* separately so "healthy" never means more
 * than it has actually verified. It does not call OpenAI or Google on every probe —
 * those are checked with `?deep=1`, and even then a provider outage is reported as
 * `degraded` rather than turning the service "unhealthy".
 */
async function pingSupabase(): Promise<{ ok: boolean; detail: string }> {
  const e = env();
  if (!e.NEXT_PUBLIC_SUPABASE_URL) return { ok: false, detail: "NEXT_PUBLIC_SUPABASE_URL not set" };
  try {
    const response = await fetch(`${e.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: e.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "" },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    return { ok: response.ok, detail: `auth health HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

async function pingProvider(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    return { ok: response.status < 500, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

export async function GET(request: Request) {
  const deep = new URL(request.url).searchParams.get("deep") === "1";
  const features = availability();

  const checks: Record<string, { ok: boolean; detail: string }> = {
    supabase: features.supabase
      ? await pingSupabase()
      : { ok: false, detail: "not configured" },
  };

  if (deep && features.ai) {
    checks.openai = await pingProvider(env().OPENAI_BASE_URL ?? "https://api.openai.com/v1/models");
  }
  if (deep && features.google) {
    checks.google = await pingProvider("https://oauth2.googleapis.com/");
  }

  const required = ["supabase"];
  const healthy = required.every((k) => checks[k]?.ok);
  const degraded = Object.values(checks).some((c) => !c.ok);

  return NextResponse.json(
    {
      status: healthy ? (degraded ? "degraded" : "ok") : "unhealthy",
      version: process.env.npm_package_version ?? "0.1.0",
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
      uptimeSeconds: Math.round(process.uptime()),
      time: new Date().toISOString(),
      features,
      checks,
    },
    { status: healthy ? 200 : 503, headers: { "cache-control": "no-store" } }
  );
}
