import { describe, expect, it } from "vitest";
import { enqueueJob, jobKey, reconcileReminders } from "@/lib/scheduler/queue";
import { defaultDigestRunAt } from "@/lib/scheduler/runner";
import { fakeClient } from "./helpers";

describe("job keys", () => {
  it("identifies one reminder occurrence regardless of date formatting", () => {
    const a = jobKey("rem-1", "2026-10-26T09:00:00.000Z");
    const b = jobKey("rem-1", new Date("2026-10-26T09:00:00Z"));
    expect(a).toBe(b);
    expect(a).toBe("reminder:rem-1:2026-10-26T09:00:00.000Z");
  });

  it("treats the next occurrence of a recurring reminder as new work", () => {
    expect(jobKey("rem-1", "2026-10-26T09:00:00Z")).not.toBe(
      jobKey("rem-1", "2026-10-27T09:00:00Z")
    );
  });
});

describe("enqueue idempotency", () => {
  it("returns the existing job instead of creating a duplicate", async () => {
    const inserts: unknown[] = [];
    const { client } = fakeClient((record) => {
      if (record.table !== "scheduled_jobs") return { data: null, error: null };
      const isInsert = record.filters.some((f) => f[0] === "insert");
      if (isInsert) {
        inserts.push(record.filters);
        return { data: { id: "new" }, error: null };
      }
      return { data: { id: "existing-job" }, error: null };
    });

    const id = await enqueueJob(client as never, {
      userId: "u1",
      kind: "reminder_due",
      runAt: "2026-10-26T09:00:00Z",
      idempotencyKey: "reminder:rem-1:2026-10-26T09:00:00.000Z",
    });

    expect(id).toBe("existing-job");
    expect(inserts).toHaveLength(0);
  });

  it("inserts with the user, key, priority and retry ceiling when new", async () => {
    let inserted: Record<string, unknown> | null = null;
    const { client } = fakeClient((record) => {
      const insert = record.filters.find((f) => f[0] === "insert");
      if (insert) {
        inserted = insert[1] as Record<string, unknown>;
        return { data: { id: "job-1" }, error: null };
      }
      return { data: null, error: null };
    });

    const id = await enqueueJob(client as never, {
      userId: "u1",
      kind: "digest",
      runAt: new Date("2026-10-26T09:00:00Z"),
      payload: { hour: 9 },
      idempotencyKey: "digest:u1:2026-10-26",
      priority: 2,
      maxAttempts: 5,
    });

    expect(id).toBe("job-1");
    expect(inserted).toMatchObject({
      user_id: "u1",
      kind: "digest",
      status: "scheduled",
      run_at: "2026-10-26T09:00:00.000Z",
      idempotency_key: "digest:u1:2026-10-26",
      priority: 2,
      max_attempts: 5,
    });
  });

  it("survives a lost race on the partial unique index", async () => {
    const { client } = fakeClient((record) => {
      const insert = record.filters.find((f) => f[0] === "insert");
      if (insert) {
        return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
      }
      // First lookup: nothing. Second (post-conflict) lookup: the winner's row.
      return { data: null, error: null };
    });

    const id = await enqueueJob(client as never, {
      userId: "u1",
      kind: "reminder_due",
      runAt: "2026-10-26T09:00:00Z",
      idempotencyKey: "k",
    });

    // No row to return: null, but no throw and no duplicate enqueue.
    expect(id).toBeNull();
  });
});

describe("missed-reminder reconciliation", () => {
  it("does nothing when there are no pending reminders", async () => {
    const { client } = fakeClient(() => ({ data: [], error: null }));
    await expect(reconcileReminders(client as never)).resolves.toEqual({
      enqueued: 0,
      orphaned: 0,
    });
  });

  it("is a no-op when every due reminder already has a live job", async () => {
    const reminders = [
      { id: "rem-1", user_id: "u1", due_at: "2026-10-26T09:00:00.000Z", rrule: null, status: "pending" },
    ];
    const { client } = fakeClient((record) => {
      if (record.table === "reminders") return { data: reminders, error: null };
      return {
        data: [{ idempotency_key: jobKey("rem-1", reminders[0].due_at) }],
        error: null,
      };
    });

    await expect(reconcileReminders(client as never)).resolves.toEqual({
      enqueued: 0,
      orphaned: 0,
    });
  });
});

describe("digest scheduling", () => {
  it("returns the next occurrence of the requested UTC hour", () => {
    const at = defaultDigestRunAt(7);
    expect(at.getUTCHours()).toBe(7);
    expect(at.getUTCMinutes()).toBe(0);
    expect(at.getTime()).toBeGreaterThan(Date.now() - 1000);
  });
});
