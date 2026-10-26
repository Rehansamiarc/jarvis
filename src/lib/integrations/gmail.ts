import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getGoogleAccessToken } from "./connections";

/**
 * Gmail API client (section 7).
 *
 * Messages are built as RFC 2822 and base64url-encoded before submission. Nothing is
 * sent without an approved `pending_actions` record — see the `message.send` tool.
 * Scopes are deliberately the minimum: read (to quote the message being replied to),
 * compose (drafts) and send.
 */

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GmailError";
  }
}

async function gmailFetch<T>(
  admin: SupabaseClient,
  userId: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = await getGoogleAccessToken(admin, userId, [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ]);

  const response = await fetch(`${GMAIL_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  const json = (await response.json().catch(() => null)) as
    | { error?: { code?: number; message?: string } }
    | null;

  if (!response.ok) {
    throw new GmailError(
      json?.error?.message || `Gmail responded HTTP ${response.status}`,
      response.status
    );
  }
  return json as T;
}

export interface OutgoingMessage {
  to: string;
  subject: string;
  body: string;
  /** Plain text is default; set true to send an HTML body instead. */
  html?: boolean;
  cc?: string;
  bcc?: string;
  /** Gmail message id being replied to — sets In-Reply-To/References and Re: subject. */
  replyToId?: string;
  inReplyTo?: string;
}

function encodeRfc2822(msg: OutgoingMessage, fromAddress: string): string {
  const headers: string[] = [
    `From: ${fromAddress}`,
    `To: ${msg.to}`,
    `Subject: ${encodeHeader(msg.subject)}`,
  ];
  if (msg.cc) headers.push(`Cc: ${msg.cc}`);
  if (msg.bcc) headers.push(`Bcc: ${msg.bcc}`);
  if (msg.inReplyTo) {
    headers.push(`In-Reply-To: ${msg.inReplyTo}`);
    headers.push(`References: ${msg.inReplyTo}`);
  }
  headers.push("MIME-Version: 1.0");
  headers.push(
    msg.html
      ? 'Content-Type: text/html; charset="UTF-8"'
      : 'Content-Type: text/plain; charset="UTF-8"'
  );
  return `${headers.join("\r\n")}\r\n\r\n${msg.body}`;
}

/** RFC 2047 encoded-word for non-ASCII subjects. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function base64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

export interface SendResult {
  id: string;
  threadId?: string;
}

/** Sends an already-approved message. Callers must have verified the approval record. */
export async function gmailSend(
  admin: SupabaseClient,
  userId: string,
  message: OutgoingMessage,
  fromAddress: string
): Promise<SendResult> {
  const raw = encodeRfc2822(message, fromAddress);
  const result = await gmailFetch<{ id?: string; threadId?: string }>(
    admin,
    userId,
    "/messages?send",
    { method: "POST", body: JSON.stringify({ raw: base64Url(raw) }) }
  );
  if (!result.id) throw new GmailError("Gmail accepted the request but returned no message id.", 502);
  return { id: result.id, threadId: result.threadId };
}

export async function gmailCreateDraft(
  admin: SupabaseClient,
  userId: string,
  message: OutgoingMessage,
  fromAddress: string
): Promise<{ id: string; labelIds: string[] }> {
  const raw = encodeRfc2822(message, fromAddress);
  const result = await gmailFetch<{ id?: string; labelIds?: string[] }>(
    admin,
    userId,
    "/drafts",
    { method: "POST", body: JSON.stringify({ raw: base64Url(raw) }) }
  );
  if (!result.id) throw new GmailError("Gmail did not return a draft id.", 502);
  return { id: result.id, labelIds: result.labelIds ?? [] };
}

export interface InboxMessage {
  id: string;
  threadId: string;
  snippet: string;
  from?: string;
  subject?: string;
  date?: string;
}

interface ListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  resultSizeEstimate?: number;
}

export async function gmailList(
  admin: SupabaseClient,
  userId: string,
  options: { query?: string; maxResults?: number } = {}
): Promise<InboxMessage[]> {
  const qs = new URLSearchParams({
    maxResults: String(Math.min(options.maxResults ?? 10, 25)),
  });
  if (options.query) qs.set("q", options.query);

  const list = await gmailFetch<ListResponse>(admin, userId, `/messages?${qs}`);
  if (!list.messages?.length) return [];

  const detailed = await Promise.all(
    list.messages.map((m) =>
      gmailFetch<Record<string, unknown>>(admin, userId, `/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)
        .catch(() => null)
    )
  );

  const headersOf = (payload: unknown): Record<string, string> => {
    const p = payload as { payload?: { headers?: Array<{ name: string; value: string }> } };
    const out: Record<string, string> = {};
    for (const h of p?.payload?.headers ?? []) out[h.name.toLowerCase()] = h.value;
    return out;
  };

  return detailed
    .filter((d): d is Record<string, unknown> => d !== null)
    .map((d) => {
      const headers = headersOf(d);
      return {
        id: String(d.id),
        threadId: String(d.threadId ?? ""),
        snippet: String(d.snippet ?? ""),
        from: headers.from,
        subject: headers.subject,
        date: headers.date,
      };
    });
}

export async function gmailGetMessage(
  admin: SupabaseClient,
  userId: string,
  id: string
): Promise<{
  id: string;
  threadId: string;
  from?: string;
  subject?: string;
  date?: string;
  body: string;
}> {
  const msg = (await gmailFetch<Record<string, unknown>>(
    admin,
    userId,
    `/messages/${id}?format=full`
  )) as {
    id: string;
    threadId: string;
    snippet?: string;
    payload?: {
      headers?: Array<{ name: string; value: string }>;
      body?: { data?: string };
      parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
    };
  };

  const headers: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;

  const candidates = [msg.payload?.body?.data, ...(msg.payload?.parts ?? []).map((p) => p.body?.data)];
  const encoded = candidates.find((c) => typeof c === "string" && c.length > 0);

  let body = msg.snippet ?? "";
  if (encoded) {
    const buf = Buffer.from(encoded as string, "base64");
    body = buf.toString("utf8");
  }

  return {
    id: msg.id,
    threadId: msg.threadId,
    from: headers.from,
    subject: headers.subject,
    date: headers.date,
    body,
  };
}

export interface GmailDraft {
  id: string;
  message: OutgoingMessage & { id?: string };
}

/** Read a stored draft back so the confirmation dialog can show its real contents. */
export async function gmailGetDraft(
  admin: SupabaseClient,
  userId: string,
  draftId: string
): Promise<{ id: string; to: string; subject: string; body: string }> {
  const draft = (await gmailFetch<{
    id?: string;
    message?: {
      id?: string;
      payload?: { headers?: Array<{ name: string; value: string }>; body?: { data?: string }; parts?: Array<{ body?: { data?: string } }> };
    };
  }>(admin, userId, `/drafts/${draftId}?format=full`)) as {
    id?: string;
    message?: {
      id?: string;
      payload?: {
        headers?: Array<{ name: string; value: string }>;
        body?: { data?: string };
        parts?: Array<{ body?: { data?: string } }>;
      };
    };
  };

  const headers: Record<string, string> = {};
  for (const h of draft.message?.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;

  const candidates = [
    draft.message?.payload?.body?.data,
    ...(draft.message?.payload?.parts ?? []).map((p) => p.body?.data),
  ].filter((c): c is string => Boolean(c));

  const body = candidates.length
    ? Buffer.from(candidates[0], "base64").toString("utf8")
    : "";

  return {
    id: draft.id ?? draftId,
    to: headers.to ?? "",
    subject: headers.subject ?? "",
    body,
  };
}

export async function gmailListDrafts(
  admin: SupabaseClient,
  userId: string,
  maxResults = 10
): Promise<Array<{ id: string; subject?: string; to?: string; updatedAt?: string }>> {
  const list = await gmailFetch<ListResponse>(
    admin,
    userId,
    `/drafts?maxResults=${Math.min(maxResults, 25)}`
  );
  const out: Array<{ id: string; subject?: string; to?: string; updatedAt?: string }> = [];
  for (const d of (list.messages ?? []).slice(0, maxResults)) {
    try {
      const full = await gmailGetDraft(admin, userId, d.id);
      out.push({ id: full.id, subject: full.subject, to: full.to });
    } catch {
      out.push({ id: d.id });
    }
  }
  return out;
}

/** Best-effort display address for the connected account. */
export async function gmailProfile(admin: SupabaseClient, userId: string): Promise<string> {
  try {
    const p = await gmailFetch<{ emailAddress?: string }>(admin, userId, "/profile");
    if (p.emailAddress) return p.emailAddress;
  } catch {
    /* fall through */
  }
  const { data } = await admin
    .from("profiles")
    .select("email")
    .eq("id", userId)
    .maybeSingle();
  return data?.email ?? "me";
}
