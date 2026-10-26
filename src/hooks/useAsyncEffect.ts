"use client";

import { useEffect } from "react";

/**
 * Runs a memoized async loader after the component has committed, and re-runs it whenever
 * the loader's identity changes (i.e. when its dependencies change).
 *
 * The loader is invoked on a microtask instead of synchronously in the effect body. A loader
 * typically opens with `setLoading(true)`, and React treats a synchronous `setState` during
 * the commit phase as a cascading render — the effect exists to *start* a request, not to
 * derive state from it. Deferring by one microtask keeps the request immediate (no timer, no
 * paint) while leaving the commit phase free of state updates.
 *
 * Pass a `useCallback`-wrapped function; an inline arrow would re-run on every render.
 */
export function useAsyncEffect(run: () => Promise<unknown> | void): void {
  useEffect(() => {
    void Promise.resolve().then(run);
  }, [run]);
}
