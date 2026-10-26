import { requireAuth, jsonError, jsonOk } from "@/lib/api";
import { sweep } from "@/lib/scheduler/runner";
import { reconcileReminders } from "@/lib/scheduler/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Heartbeat sweep, callable only by a signed-in user.
 *
 * Row Level Security scopes the claim to the caller's own jobs, so an open dashboard can
 * deliver *their* reminders on time without widening anything for other accounts.
 *
 * This is a supplement to cron, not a replacement: the app works with the tab closed
 * (cron + catch-up do that); this only makes timing tighter while JARVIS is open.
 */
export async function POST() {
  try {
    const auth = await requireAuth();

    const reconciled = await reconcileReminders(auth.db, { horizonMinutes: 60 * 24 * 7 });
    const result = await sweep(auth.db, {
      limit: 10,
      leaseMs: 120_000,
      kinds: ["reminder_due", "digest"],
    });

    return jsonOk({ reconciled, ...result });
  } catch (error) {
    return jsonError(error);
  }
}
