/**
 * Minimal stand-ins for the pieces of Supabase PostgREST behaviour the unit tests touch.
 *
 * The real client returns a *thenable* query builder, so a fake has to be awaitable as
 * well as chainable. Each handler receives the table and the recorded filter calls, which
 * is enough to assert that queries are scoped to the right user.
 */

export type FilterCall = [method: string, ...args: unknown[]];

export interface QueryRecord {
  table: string;
  filters: FilterCall[];
}

type Responder = (record: QueryRecord) => unknown | Promise<unknown>;

export function fakeClient(responder: Responder) {
  const calls: QueryRecord[] = [];

  const makeBuilder = (table: string): unknown => {
    const record: QueryRecord = { table, filters: [] };
    calls.push(record);

    const builder: Record<string, unknown> = {};
    let settled: Promise<unknown> | null = null;

    const settle = () => {
      settled ??= Promise.resolve(responder(record));
      return settled;
    };

    for (const method of [
      "select",
      "insert",
      "update",
      "upsert",
      "delete",
      "eq",
      "neq",
      "in",
      "is",
      "lte",
      "gte",
      "order",
      "limit",
      "rpc",
    ]) {
      builder[method] = (...args: unknown[]) => {
        record.filters.push([method, ...args]);
        return builder;
      };
    }

    builder.maybeSingle = () => settle();
    builder.single = () => settle();
    builder.then = (onFulfilled: unknown, onRejected: unknown) =>
      settle().then(onFulfilled as never, onRejected as never);

    return builder;
  };

  return {
    client: { from: (table: string) => makeBuilder(table) },
    calls,
  };
}
