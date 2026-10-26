import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { readCredentials } from "./connections";

/**
 * WordPress REST API client.
 *
 * Authentication: Application Passwords over HTTP Basic, sent only from the server.
 * WordPress passwords never touch browser storage or source code — they are read from
 * the server's encrypted `integrations` row, or from server environment variables.
 *
 * Every mutating call re-reads the object it just changed. `verified: true` means we saw
 * the change reflected by WordPress, not merely that the POST returned 2xx.
 */

export interface WpPost {
  id: number;
  status: string;
  type: string;
  link: string;
  slug: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt?: { rendered: string };
  date: string;
  date_gmt: string;
  modified_gmt: string;
  categories?: number[];
  tags?: number[];
  author: number;
}

export interface WpComment {
  id: number;
  post: number;
  status: string;
  author_name: string;
  content: { rendered: string };
  date_gmt: string;
}

export interface WpConnection {
  siteUrl: string;
  username: string;
  appPassword: string;
}

export class WordPressError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly wpCode?: string
  ) {
    super(message);
    this.name = "WordPressError";
  }
}

export async function resolveWordPressConnection(
  db: SupabaseClient,
  userId: string
): Promise<WpConnection> {
  const stored = await readCredentials(db, userId, "wordpress");
  const e = env();

  const siteUrl = (stored?.config.siteUrl as string | undefined) || e.WORDPRESS_SITE_URL;
  const username = stored?.secrets.username || e.WORDPRESS_USERNAME;
  const appPassword = stored?.secrets.appPassword || e.WORDPRESS_APP_PASSWORD;

  if (!siteUrl || !username || !appPassword) {
    throw new WordPressError(
      "WordPress is not configured for this account. Connect it in Settings → Connected " +
        "accounts (site URL, username, application password), or set WORDPRESS_SITE_URL / " +
        "WORDPRESS_USERNAME / WORDPRESS_APP_PASSWORD on the server.",
      400,
      "not_configured"
    );
  }
  return { siteUrl: siteUrl.replace(/\/$/, ""), username, appPassword };
}

async function wpFetch<T>(
  conn: WpConnection,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = `${conn.siteUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization:
        "Basic " + Buffer.from(`${conn.username}:${conn.appPassword}`).toString("base64"),
      accept: "application/json",
      ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      /* HTML error page or non-JSON body */
    }
  }

  if (!response.ok) {
    const err = json as { message?: string; code?: string; data?: { status?: number } } | null;
    throw new WordPressError(
      err?.message || `WordPress responded HTTP ${response.status} for ${path}`,
      err?.data?.status ?? response.status,
      err?.code
    );
  }

  return json as T;
}

export async function wpSiteStatus(conn: WpConnection): Promise<{
  ok: boolean;
  name?: string;
  url?: string;
  version?: string;
  namespaces?: string[];
  error?: string;
}> {
  try {
    const data = await wpFetch<{
      name?: string;
      url?: string;
      description?: string;
      namespaces?: string[];
      gmt_offset?: number;
    }>(conn, "/wp-json/");
    return {
      ok: true,
      name: data.name,
      url: data.url,
      namespaces: data.namespaces ?? [],
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export async function wpSearchPosts(
  conn: WpConnection,
  params: { query?: string; status?: string; perPage?: number; page?: number }
): Promise<WpPost[]> {
  const qs = new URLSearchParams({
    per_page: String(Math.min(params.perPage ?? 10, 50)),
    page: String(params.page ?? 1),
    orderby: "modified",
    order: "desc",
    _fields: "id,status,type,link,slug,title,content,excerpt,date,date_gmt,modified_gmt,categories,tags,author",
  });
  if (params.query) qs.set("search", params.query);
  if (params.status) qs.set("status", params.status);
  return wpFetch<WpPost[]>(conn, `/wp-json/wp/v2/posts?${qs}`);
}

export async function wpGetPost(conn: WpConnection, id: number): Promise<WpPost> {
  return wpFetch<WpPost>(conn, `/wp-json/wp/v2/posts/${id}`);
}

export interface WpCreatePostInput {
  title: string;
  content: string;
  excerpt?: string;
  status?: "draft" | "publish" | "future" | "pending";
  categories?: number[];
  tags?: number[];
  slug?: string;
  /** ISO 8601 local time; only meaningful with status "future". */
  date?: string;
}

export async function wpCreatePost(
  conn: WpConnection,
  input: WpCreatePostInput
): Promise<{ post: WpPost; verified: boolean }> {
  const body: Record<string, unknown> = {
    title: input.title,
    content: input.content,
    status: input.status ?? "draft",
  };
  if (input.excerpt) body.excerpt = input.excerpt;
  if (input.categories?.length) body.categories = input.categories;
  if (input.tags?.length) body.tags = input.tags;
  if (input.slug) body.slug = input.slug;
  if (input.date) body.date = input.date;

  const created = await wpFetch<WpPost>(conn, "/wp-json/wp/v2/posts", {
    method: "POST",
    body: JSON.stringify(body),
  });

  // Verification: read the post back rather than trusting the write response.
  try {
    const confirmed = await wpGetPost(conn, created.id);
    return { post: confirmed, verified: confirmed.id === created.id && confirmed.status === (input.status ?? "draft") };
  } catch {
    return { post: created, verified: false };
  }
}

export async function wpUpdatePost(
  conn: WpConnection,
  id: number,
  fields: { title?: string; content?: string; excerpt?: string; status?: string; date?: string }
): Promise<{ post: WpPost; verified: boolean }> {
  const updated = await wpFetch<WpPost>(conn, `/wp-json/wp/v2/posts/${id}`, {
    method: "POST",
    body: JSON.stringify(fields),
  });
  try {
    const confirmed = await wpGetPost(conn, id);
    const ok =
      confirmed.id === id &&
      (!fields.title || stripHtml(confirmed.title.rendered).trim() === fields.title.trim()) &&
      (!fields.status || confirmed.status === fields.status);
    return { post: confirmed, verified: ok };
  } catch {
    return { post: updated, verified: false };
  }
}

export async function wpListComments(
  conn: WpConnection,
  params: { status?: string; postId?: number; perPage?: number }
): Promise<WpComment[]> {
  const qs = new URLSearchParams({
    per_page: String(Math.min(params.perPage ?? 20, 50)),
    orderby: "date_gmt",
    order: "desc",
  });
  if (params.status) qs.set("status", params.status);
  if (params.postId) qs.set("post", String(params.postId));
  return wpFetch<WpComment[]>(conn, `/wp-json/wp/v2/comments?${qs}`);
}

export async function wpModerateComment(
  conn: WpConnection,
  id: number,
  status: "approved" | "hold" | "spam" | "trash"
): Promise<{ comment: WpComment; verified: boolean }> {
  const updated = await wpFetch<WpComment>(conn, `/wp-json/wp/v2/comments/${id}`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
  try {
    const list = await wpFetch<WpComment[]>(conn, `/wp-json/wp/v2/comments?include=${id}&per_page=1`);
    const confirmed = list[0];
    return { comment: confirmed ?? updated, verified: confirmed?.status === status };
  } catch {
    return { comment: updated, verified: false };
  }
}

/**
 * Uploads media from a public URL. We fetch the bytes server-side so no credentials or
 * intermediate URLs reach the browser, then POST to the WP media endpoint.
 */
export async function wpUploadMediaFromUrl(
  conn: WpConnection,
  sourceUrl: string,
  filename?: string
): Promise<{ id: number; sourceUrl: string; verified: boolean }> {
  const fetched = await fetch(sourceUrl, { cache: "no-store" });
  if (!fetched.ok) {
    throw new WordPressError(`Could not download media from ${sourceUrl}: HTTP ${fetched.status}`, 400);
  }
  const contentType = fetched.headers.get("content-type") ?? "image/jpeg";
  const bytes = Buffer.from(await fetched.arrayBuffer());
  const name = filename ?? (new URL(sourceUrl).pathname.split("/").pop() || "upload.jpg");

  const created = await wpFetch<{ id: number; source_url: string }>(conn, "/wp-json/wp/v2/media", {
    method: "POST",
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
      "content-length": String(bytes.length),
    },
    body: bytes,
  });

  let verified = false;
  try {
    const check = await wpFetch<{ id: number }>(conn, `/wp-json/wp/v2/media/${created.id}`);
    verified = check.id === created.id;
  } catch {
    verified = false;
  }
  return { id: created.id, sourceUrl: created.source_url ?? sourceUrl, verified };
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
