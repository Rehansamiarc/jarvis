import "server-only";
import { env } from "@/lib/env";

/**
 * Resend — a deliberately simple transactional fallback used when no Gmail account is
 * connected, or when the user prefers a domain-verified sending identity.
 *
 * This sends as the *application's* identity, not as the user's own mailbox, so the
 * confirmation dialog always states which identity the message will come from.
 */

export class ResendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResendUnavailableError";
  }
}

export interface ResendInput {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  cc?: string[];
}

export async function resendAvailable(): Promise<boolean> {
  return Boolean(env().RESEND_API_KEY);
}

export async function sendViaResend(input: ResendInput): Promise<{ id: string }> {
  const apiKey = env().RESEND_API_KEY;
  const from = env().RESEND_FROM ?? "JARVIS <onboarding@resend.dev>";

  if (!apiKey) {
    throw new ResendUnavailableError(
      "No email provider is connected. Connect Gmail in Settings → Connected accounts, or set " +
        "RESEND_API_KEY on the server to enable the transactional fallback."
    );
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      html: input.html,
      reply_to: input.replyTo,
      cc: input.cc,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });

  const json = (await response.json().catch(() => null)) as
    | { id?: string; message?: string }
    | null;

  if (!response.ok) {
    throw new Error(`Email provider rejected the message (HTTP ${response.status}): ${json?.message ?? "unknown error"}`);
  }
  if (!json?.id) throw new Error("Email provider accepted the request but returned no message id.");
  return { id: json.id };
}

/** Non-fatal notification email used by the scheduler, not by the agent's send tool. */
export async function sendNotificationEmail(
  to: string,
  subject: string,
  body: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await sendViaResend({ to, subject, text: body });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
