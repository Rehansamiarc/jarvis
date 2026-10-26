import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { availability } from "@/lib/env";
import AppShell from "@/components/AppShell";
import SetupNotice from "@/components/SetupNotice";

/**
 * Server-side gate for every application page. This is presentation-layer convenience —
 * the real enforcement is `getUser()` (a network round trip, so unfakeable) plus Row
 * Level Security on every table.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const features = availability();

  if (!features.supabase) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl items-center px-6">
        <SetupNotice
          title="Database not configured"
          missing={["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]}
        />
      </main>
    );
  }

  let email = "";
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");
    email = user.email ?? "";
  } catch (error) {
    // `redirect()` throws NEXT_REDIRECT — rethrow so Next.js can act on it.
    if (String(error).includes("NEXT_REDIRECT")) throw error;
    redirect("/login");
  }

  return <AppShell email={email}>{children}</AppShell>;
}
