"use client";
import { createBrowserClient } from "@supabase/ssr";
import { normalizeSupabaseUrl } from "@/lib/env";

/**
 * Browser client. Uses the public anon key — all data access is gated by Row Level
 * Security, so possession of this key grants nothing beyond the caller's own rows.
 *
 * The URL is normalised here too: this file reads `process.env` directly (Next inlines
 * NEXT_PUBLIC_* at build time, so `env()` must not run in the browser), and a REST-shaped
 * URL would otherwise break the browser client while the server worked.
 */
export function createClient() {
  const url = normalizeSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL!);
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createBrowserClient(url, anonKey);
}
