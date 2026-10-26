import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { availability } from "@/lib/env";
import SetupNotice from "@/components/SetupNotice";

/**
 * Root route: sends a signed-in user to the dashboard and everyone else to sign-in.
 * When core configuration is missing it says exactly which variable, instead of
 * rendering an app that fails on the first API call.
 */
export default async function Home() {
  const features = availability();

  if (!features.supabase) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl items-center px-6">
        <SetupNotice
          title="JARVIS is not configured yet"
          missing={[
            "NEXT_PUBLIC_SUPABASE_URL",
            "NEXT_PUBLIC_SUPABASE_ANON_KEY",
            "SECRET_ENCRYPTION_KEY",
          ]}
        />
      </main>
    );
  }

  let signedIn = false;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    signedIn = Boolean(user);
  } catch {
    signedIn = false;
  }
  redirect(signedIn ? "/dashboard" : "/login");
}
