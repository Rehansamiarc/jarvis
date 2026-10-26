import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { authorizeCron, jsonError } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { sweep } from "@/lib/scheduler/runner";
import { reconcileReminders, enqueueJob } from "@/lib/scheduler/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Reminder sweep (section 9).
 *
 * Drains every overdue reminder for every account. Because the claim query is "run_at <=
 * now" rather than "run_at in this minute", a cron that fires late — or does not fire at
 * all on one day — still delivers everything on the next successful invocation.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`. Fails closed when the secret is unset.
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

    const reconciled = await reconcileReminders(admin, { horizonMinutes: 60 * 24 * 7 });

    const result = await sweep(admin, {
      limit: 50,
      leaseMs: 300_000,
      kinds: ["reminder_due"],
    });

    // Queue tomorrow's digest while the scheduler is awake.
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, timezone")
      .limit(1000);

    let digestsQueued = 0;
    for (const profile of profiles ?? []) {
      const { data: prefs } = await admin
        .from("user_preferences")
        .select("notify_in_app, digest_hour")
        .eq("user_id", profile.id as string)
        .maybeSingle();
      if (prefs && !prefs.notify_in_app) continue;

      const next = nextDigestAt(profile.timezone as string, prefs?.digest_hour ?? 9);
      const id = await enqueueJob(admin, {
        userId: profile.id as string,
        kind: "digest",
        runAt: next,
        idempotencyKey: `digest:${profile.id}:${next.toISOString().slice(0, 13)}`,
        priority: 7,
      });
      if (id) digestsQueued++;
    }

    const ok = result.errors.length === 0;
    return NextResponse.json(
      { ok, reconciled, digestsQueued, ...result },
      { status: ok ? 200 : 207, headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return jsonError(error);
  }
}

function nextDigestAt(timezone: string, hourLocal: number): Date {
  const hour = Math.min(23, Math.max(0, Math.trunc(hourLocal)));
  let local = DateTime.now().setZone(timezone);
  if (!local.isValid) local = DateTime.now().setZone("utc");

  let target = local.set({ hour, minute: 0, second: 0, millisecond: 0 });
  if (target.toMillis() <= local.toMillis()) target = target.plus({ days: 1 });
  return target.toJSDate();
}
