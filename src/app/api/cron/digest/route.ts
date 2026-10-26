import { NextResponse } from "next/server";
import { authorizeCron, jsonError } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { sweep } from "@/lib/scheduler/runner";
import { enqueueJob } from "@/lib/scheduler/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily briefing. For each account with digests enabled, queue one `digest` job for now
 * and drain it. Separated from /api/cron/reminders so briefing generation (which reads
 * several tables) can fail without affecting reminder delivery.
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
    const { data: profiles } = await admin.from("profiles").select("id").limit(1000);

    let queued = 0;
    for (const profile of profiles ?? []) {
      const userId = profile.id as string;
      const { data: prefs } = await admin
        .from("user_preferences")
        .select("notify_in_app")
        .eq("user_id", userId)
        .maybeSingle();
      if (prefs && !prefs.notify_in_app) continue;

      const id = await enqueueJob(admin, {
        userId,
        kind: "digest",
        runAt: new Date(),
        idempotencyKey: `digest:${userId}:${new Date().toISOString().slice(0, 10)}`,
        priority: 7,
      });
      if (id) queued++;
    }

    const result = await sweep(admin, { limit: 100, kinds: ["digest"] });
    const ok = result.errors.length === 0;
    return NextResponse.json(
      { ok, queued, ...result },
      { status: ok ? 200 : 207, headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return jsonError(error);
  }
}
