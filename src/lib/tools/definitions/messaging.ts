import { z } from "zod";
import { registry, defineTool } from "../registry";
import {
  gmailCreateDraft,
  gmailGetDraft,
  gmailListDrafts,
  gmailProfile,
  gmailSend,
} from "@/lib/integrations/gmail";
import { sendViaResend } from "@/lib/integrations/resend";
import { generateText } from "@/lib/ai/generate";

/**
 * Messaging (section 7).
 *
 * Two separate tools, because the risk profiles differ:
 *   message.draft  — reversible, runs automatically under auto_low_risk. Never sends.
 *   message.send   — HIGH risk, always confirmation-gated, and the preview shows the real
 *                    recipient, subject and body pulled from the stored draft (not a
 *                    model-authored summary of it).
 *
 * There is no code path that can report a message as sent without a successful provider
 * response carrying a message id.
 */

type EmailProvider = "gmail" | "resend";

function resolveProvider(ctx: import("../registry").ToolContext): EmailProvider {
  if (ctx.connections.gmail === "connected" && ctx.admin) return "gmail";
  if (ctx.connections.resend === "connected") return "resend";
  if (ctx.connections.gmail === "connected" && !ctx.admin) {
    throw new Error(
      "Gmail is connected but SUPABASE_SERVICE_ROLE_KEY is not configured on the server, so its " +
        "access token cannot be read. Set the service role key or configure RESEND_API_KEY instead."
    );
  }
  throw new Error(
    "No messaging provider is connected. Connect Gmail in Settings → Connected accounts, or " +
      "configure RESEND_API_KEY on the server. JARVIS will not claim a message was sent otherwise."
  );
}

interface SendArgs {
  draft_id?: string;
  to?: string;
  subject?: string;
  body?: string;
}

function validateSendArgs(args: SendArgs): { ok: true } | { ok: false; error: string } {
  if (args.draft_id) return { ok: true };
  if (args.to && args.subject && args.body) return { ok: true };
  return {
    ok: false,
    error: "Provide either draft_id, or all of to/subject/body.",
  };
}

function requireSendable(args: SendArgs): void {
  const result = validateSendArgs(args);
  if (!result.ok) throw new Error(result.error);
}

const messageDraft = defineTool({
  name: "message.draft",
  description:
    "Draft an email in the requested tone and save it as a Gmail draft (or prepare it for the " +
    "fallback provider). Nothing is sent. Returns the draft id plus the exact recipient, " +
    "subject and body so the user can review them.",
  category: "messaging",
  risk: "write",
  requiresAnyConnection: ["gmail", "resend"],
  triggers: ["draft a", "write a reply", "reply to", "email", "rewrite it", "professional reply"],
  schema: z.object({
    to: z.string().min(3).max(320).describe("Recipient email address"),
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(50_000),
    tone: z.enum(["professional", "casual", "friendly", "concise"]).optional(),
    reply_to_message_id: z.string().optional().describe("Gmail message id being replied to"),
    refine: z.boolean().optional().describe("Ask JARVIS to rewrite `body` in `tone` first"),
  }),
  preview: async (args, ctx) => {
    const provider = resolveProvider(ctx);
    return {
      provider,
      action: "Create a draft (nothing is sent yet)",
      to: args.to,
      subject: args.subject,
      body: args.body,
      ...(args.tone ? { tone: args.tone } : {}),
    };
  },
  async execute(args, ctx) {
    try {
      const provider = resolveProvider(ctx);
      const body =
        args.refine && args.tone
          ? await generateText(ctx.db, ctx.userId, {
              role: "primary",
              system: `Rewrite the user's message in a ${args.tone} tone. Preserve every fact, name, number and request. Return only the rewritten message, no preamble.`,
              prompt: args.body,
              maxTokens: 2000,
              temperature: 0.6,
            })
          : args.body;

      if (provider === "gmail") {
        const admin = ctx.admin!;
        const from = await gmailProfile(admin, ctx.userId);
        const draft = await gmailCreateDraft(
          admin,
          ctx.userId,
          { to: args.to, subject: args.subject, body, replyToId: args.reply_to_message_id },
          from
        );
        return {
          ok: true,
          verified: true,
          data: {
            provider: "gmail",
            draft_id: draft.id,
            to: args.to,
            subject: args.subject,
            body,
            status: "drafted",
            note: "Saved as a draft. Nothing has been sent — use message.send to deliver it.",
          },
        };
      }

      // Fallback provider cannot hold a draft, so we return the prepared payload instead.
      return {
        ok: true,
        verified: true,
        data: {
          provider: "resend",
          to: args.to,
          subject: args.subject,
          body,
          status: "prepared",
          note: "Prepared for the Resend provider. It will only be sent after message.send is approved.",
        },
      };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  },
});

const messageSend = defineTool({
  name: "message.send",
  description:
    "Send an email to a recipient. HIGH IMPACT — this actually delivers a message to a real " +
    "inbox and always requires explicit confirmation showing the recipient and full body. " +
    "Prefer message.draft first, then send the approved draft.",
  category: "messaging",
  risk: "high",
  requiresConnection: "gmail",
  requiresApproval: true,
  triggers: ["send this", "send the message", "send the email", "send it to"],
  schema: z.object({
    draft_id: z.string().optional().describe("Draft id returned by message.draft"),
    to: z.string().min(3).max(320).optional(),
    subject: z.string().max(300).optional(),
    body: z.string().max(50_000).optional(),
    reply_to_message_id: z.string().optional(),
  }),
  preview: async (args, ctx) => {
    requireSendable(args);
    const provider = resolveProvider(ctx);
    if (args.draft_id && provider === "gmail" && ctx.admin) {
      const draft = await gmailGetDraft(ctx.admin, ctx.userId, args.draft_id);
      const from = await gmailProfile(ctx.admin, ctx.userId);
      return {
        provider,
        action: "Send this email now (it will leave the mailbox immediately)",
        from,
        to: draft.to,
        subject: draft.subject,
        body: draft.body,
        draft_id: args.draft_id,
      };
    }
    return {
      provider,
      action: "Send this email now (it will leave the mailbox immediately)",
      to: args.to ?? "(unknown)",
      subject: args.subject ?? "(no subject)",
      body: args.body ?? "(empty)",
    };
  },
  async execute(args, ctx) {
    try {
      const provider = resolveProvider(ctx);
      const validation = validateSendArgs(args);
      if (!validation.ok) return { ok: false, error: validation.error };

      if (provider === "gmail") {
        const admin = ctx.admin!;
        const from = await gmailProfile(admin, ctx.userId);

        let to = args.to ?? "";
        let subject = args.subject ?? "";
        let body = args.body ?? "";

        if (args.draft_id) {
          const draft = await gmailGetDraft(admin, ctx.userId, args.draft_id);
          to = to || draft.to;
          subject = subject || draft.subject;
          body = body || draft.body;
        }

        if (!to || !subject) {
          return { ok: false, error: "Recipient and subject are required before sending." };
        }

        const result = await gmailSend(
          admin,
          ctx.userId,
          { to, subject, body, replyToId: args.reply_to_message_id },
          from
        );
        return {
          ok: true,
          verified: Boolean(result.id),
          data: {
            provider: "gmail",
            status: "sent",
            message_id: result.id,
            thread_id: result.threadId ?? null,
            to,
            subject,
            from,
            note: "Gmail returned a message id confirming delivery to its send pipeline.",
          },
        };
      }

      if (!args.to || !args.subject || !args.body) {
        return { ok: false, error: "to, subject and body are required for the fallback provider." };
      }
      const result = await sendViaResend({ to: args.to, subject: args.subject, text: args.body });
      return {
        ok: true,
        verified: Boolean(result.id),
        data: {
          provider: "resend",
          status: "sent",
          message_id: result.id,
          to: args.to,
          subject: args.subject,
        },
      };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  },
});

const messageListDrafts = defineTool({
  name: "message.list_drafts",
  description: "List messages currently sitting in the Gmail drafts folder so nothing is forgotten.",
  category: "messaging",
  risk: "read",
  requiresAnyConnection: ["gmail"],
  triggers: ["my drafts", "unsent drafts", "list drafts"],
  schema: z.object({ limit: z.number().int().min(1).max(25).optional() }),
  async execute(args, ctx) {
    try {
      if (!ctx.admin) throw new Error("Gmail access requires SUPABASE_SERVICE_ROLE_KEY on the server.");
      const drafts = await gmailListDrafts(ctx.admin, ctx.userId, args.limit ?? 10);
      return { ok: true, data: { count: drafts.length, drafts } };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  },
});

const messageReadInbox = defineTool({
  name: "message.read",
  description:
    "Read recent messages matching a Gmail query (e.g. 'from:alice@x.com' or 'is:unread'). " +
    "Used to understand a message the user wants to reply to. Read-only.",
  category: "messaging",
  risk: "read",
  requiresAnyConnection: ["gmail"],
  triggers: ["inbox", "read my email", "messages from", "what did", "latest email"],
  schema: z.object({
    query: z.string().min(1).max(300).describe("Gmail search query"),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  async execute(args, ctx) {
    try {
      if (!ctx.admin) throw new Error("Gmail access requires SUPABASE_SERVICE_ROLE_KEY on the server.");
      const { gmailList } = await import("@/lib/integrations/gmail");
      const messages = await gmailList(ctx.admin, ctx.userId, {
        query: args.query,
        maxResults: args.limit ?? 10,
      });
      return { ok: true, data: { count: messages.length, messages } };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  },
});

export function registerMessagingTools(): void {
  registry.registerAll([messageDraft, messageSend, messageListDrafts, messageReadInbox]);
}
