import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { MissingEnvError } from "@/lib/env";

/**
 * Shared API plumbing: one place that decides what "unauthorized" and "misconfigured"
 * look like, so every route answers with the same contract.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function jsonError(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  if (error instanceof MissingEnvError) {
    return NextResponse.json({ error: error.message, code: "not_configured" }, { status: 503 });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error("[jarvis] api error:", message);
  return NextResponse.json({ error: message, code: "internal" }, { status: 500 });
}

export function jsonOk<T>(data: T, init?: ResponseInit): NextResponse {
  const headers = new Headers(init?.headers);
  // Personalised data must never be cached by a shared cache.
  headers.set("cache-control", "no-store");
  return NextResponse.json(data as never, { ...init, headers });
}

export interface AuthedRequest {
  db: SupabaseClient;
  admin: SupabaseClient | null;
  userId: string;
}

/**
 * Resolves the caller. Returns null (which callers translate to 401) when there is no
 * valid session — `getUser()` makes a network call to Supabase, so it cannot be spoofed
 * by a forged cookie.
 */
export async function withAuth(): Promise<AuthedRequest | null> {
  try {
    const db = await createClient();
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) return null;
    return { db, admin: safeAdmin(), userId: user.id };
  } catch (error) {
    console.error("[jarvis] auth resolution failed:", (error as Error).message);
    return null;
  }
}

export async function requireAuth(): Promise<AuthedRequest> {
  const auth = await withAuth();
  if (!auth) throw new ApiError("Not signed in.", 401, "unauthorized");
  return auth;
}

function safeAdmin(): SupabaseClient | null {
  try {
    return createAdminClient();
  } catch {
    return null;
  }
}

/** Reads and parses a JSON body, rejecting malformed input with a 400. */
export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ApiError(`Request body is not valid JSON: ${(error as Error).message}`, 400, "bad_request");
  }
}

/** Verifies CRON_SECRET on scheduled endpoints. Vercel Cron sends `Bearer <secret>`. */
export function authorizeCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Fail closed: without a configured secret we will not run cross-user jobs.
    return false;
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^bearer\s+/i, "");
  if (token && token === secret) return true;

  // Vercel also forwards it as a query parameter for `?cron=` style configurations.
  const url = new URL(request.url);
  return url.searchParams.get("secret") === secret;
}
