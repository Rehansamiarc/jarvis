import { NextResponse } from "next/server";
import { authorizeCron, jsonError } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { sweep } from "@/lib/scheduler/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Background job sweep: automations, task runs, webhooks and maintenance.
 * Reminders are handled by /api/cron/reminders so a slow automation cannot starve them.
 */
export async function GET(request: Request) {
  return handle(request);
}
export async function POST(request: Request) {
  return handle(request);
}

async function handle(request: Request) {
  try {
    if (!authorizeCron(request)) {
      return NextResponse.json(
        { error: "Unauthorized: CRON_SECRET missing or mismatched." },
        { status: 401 }
      );
    }

    const admin = createAdminClient();

    const result = await sweep(admin, {
      limit: 25,
      leaseMs: 300_000,
      kinds: ["task_run", "automation", "webhook", "reindex", "maintenance"],
    });

    const ok = result.errors.length === 0;
    return NextResponse.json(
      { ok, ...result },
      { status: ok ? 200 : 207, headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return jsonError(error);
  }
}
