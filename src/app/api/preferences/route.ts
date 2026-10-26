import { requireAuth, jsonError, jsonOk, readJson, ApiError } from "@/lib/api";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PrefSchema = z.object({
  personality: z.string().min(1).max(2000).optional(),
  voice_enabled: z.boolean().optional(),
  voice_name: z.string().max(120).nullable().optional(),
  speech_rate: z.number().min(0.5).max(2).optional(),
  speech_pitch: z.number().min(0.5).max(2).optional(),
  language: z.string().min(2).max(32).optional(),
  wake_word_enabled: z.boolean().optional(),
  permission_mode: z.enum(["read_only", "auto_low_risk", "auto_approved", "ask_everything"]).optional(),
  notify_in_app: z.boolean().optional(),
  notify_email: z.boolean().optional(),
  digest_hour: z.number().int().min(0).max(23).optional(),
  automations_paused: z.boolean().optional(),
  retention_days: z.number().int().min(30).max(3650).optional(),
  timezone: z.string().max(64).optional(),
  full_name: z.string().max(200).nullable().optional(),
});

export async function GET() {
  try {
    const auth = await requireAuth();
    const [prefs, profile] = await Promise.all([
      auth.db.from("user_preferences").select("*").eq("user_id", auth.userId).maybeSingle(),
      auth.db.from("profiles").select("email, full_name, timezone, created_at").eq("id", auth.userId).maybeSingle(),
    ]);
    if (prefs.error) throw new Error(prefs.error.message);
    return jsonOk({ preferences: prefs.data ?? null, profile: profile.data ?? null });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = await requireAuth();
    const parsed = PrefSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new ApiError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        400,
        "validation"
      );
    }

    const { timezone, full_name, ...prefs } = parsed.data;

    if (Object.keys(prefs).length) {
      const { error } = await auth.db
        .from("user_preferences")
        .upsert({ user_id: auth.userId, ...prefs }, { onConflict: "user_id" });
      if (error) throw new Error(error.message);
    }

    const profilePatch: Record<string, unknown> = {};
    if (timezone !== undefined) profilePatch.timezone = timezone;
    if (full_name !== undefined) profilePatch.full_name = full_name;
    if (Object.keys(profilePatch).length) {
      const { error } = await auth.db.from("profiles").update(profilePatch).eq("id", auth.userId);
      if (error) throw new Error(error.message);
    }

    const { data } = await auth.db
      .from("user_preferences")
      .select("*")
      .eq("user_id", auth.userId)
      .maybeSingle();

    return jsonOk({ preferences: data });
  } catch (error) {
    return jsonError(error);
  }
}
