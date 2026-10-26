"use client";
import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser client. Uses the public anon key — all data access is gated by Row Level
 * Security, so possession of this key grants nothing beyond the caller's own rows.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createBrowserClient(url, anonKey);
}
