import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getGoogleAccessToken, NotConnectedError } from "./connections";

/**
 * YouTube Data API v3 + YouTube Analytics API client.
 *
 * Uses the user's own OAuth grant (server-held refresh token) and asks for
 * `youtube.readonly` by default so reading costs no extra quota beyond the standard
 * 10,000 units/day default. Uploads additionally need `youtube.upload`.
 *
 * Quota note: a `videos.list` call costs 1 unit, `search.list` costs 100. We default to
 * `videos.list` with `mine=true` and only use `search.list` when the caller explicitly
 * asks for a keyword search, because that is what keeps a personal channel inside its
 * daily quota.
 */

const DATA_BASE = "https://www.googleapis.com/youtube/v3";
const ANALYTICS_BASE = "https://youtubeanalytics.googleapis.com/v2";

export interface YouTubeChannel {
  id: string;
  title: string;
  description: string;
  customUrl?: string;
  thumbnailUrl?: string;
  subscribers: number;
  totalViews: number;
  totalVideos: number;
}

export interface YouTubeVideo {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  channelTitle: string;
  thumbnailUrl?: string;
  tags: string[];
  duration: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
}

export class YouTubeError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) {
    super(message);
    this.name = "YouTubeError";
  }
}

async function ytFetch<T>(
  token: string,
  url: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
  });
  const json = (await response.json().catch(() => null)) as
    | { error?: { code?: number; message?: string; errors?: Array<{ reason?: string }> } }
    | null;

  if (!response.ok) {
    const reason = json?.error?.errors?.[0]?.reason;
    throw new YouTubeError(
      json?.error?.message || `YouTube API responded HTTP ${response.status}`,
      response.status,
      reason
    );
  }
  return json as T;
}

async function tokenFor(admin: SupabaseClient, userId: string): Promise<string> {
  return getGoogleAccessToken(admin, userId, [
    "https://www.googleapis.com/auth/youtube.readonly",
  ]);
}

export async function getChannel(admin: SupabaseClient, userId: string): Promise<YouTubeChannel> {
  const token = await tokenFor(admin, userId);
  const data = await ytFetch<{
    items?: Array<{
      id: string;
      snippet: { title: string; description: string; customUrl?: string; thumbnails?: { default?: { url: string } } };
      statistics: { viewCount: string; subscriberCount: string; videoCount: string; hiddenSubscriberCount?: boolean };
    }>;
  }>(token, `${DATA_BASE}/channels?part=snippet,statistics&mine=true`);

  const item = data.items?.[0];
  if (!item) throw new YouTubeError("No channel is associated with the connected Google account.", 404, "channelNotFound");

  return {
    id: item.id,
    title: item.snippet.title,
    description: item.snippet.description,
    customUrl: item.snippet.customUrl,
    thumbnailUrl: item.snippet.thumbnails?.default?.url,
    subscribers: Number(item.statistics.subscriberCount ?? 0),
    totalViews: Number(item.statistics.viewCount ?? 0),
    totalVideos: Number(item.statistics.videoCount ?? 0),
  };
}

export async function listVideos(
  admin: SupabaseClient,
  userId: string,
  options: { maxResults?: number } = {}
): Promise<YouTubeVideo[]> {
  const token = await tokenFor(admin, userId);
  const data = await ytFetch<{
    items?: Array<{
      id: string;
      snippet: { title: string; description: string; publishedAt: string; channelTitle: string; tags?: string[]; thumbnails?: { medium?: { url: string } } };
      contentDetails?: { duration?: string };
      statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
    }>;
  }>(
    token,
    `${DATA_BASE}/videos?part=snippet,statistics,contentDetails&mine=true&order=date&maxResults=${Math.min(
      options.maxResults ?? 25,
      50
    )}`
  );

  return (data.items ?? []).map((v) => ({
    id: v.id,
    title: v.snippet.title,
    description: v.snippet.description,
    publishedAt: v.snippet.publishedAt,
    channelTitle: v.snippet.channelTitle,
    thumbnailUrl: v.snippet.thumbnails?.medium?.url,
    tags: v.snippet.tags ?? [],
    duration: v.contentDetails?.duration ?? "",
    viewCount: Number(v.statistics?.viewCount ?? 0),
    likeCount: Number(v.statistics?.likeCount ?? 0),
    commentCount: Number(v.statistics?.commentCount ?? 0),
  }));
}

/** Keyword search — 100 quota units per call, so it is opt-in and capped. */
export async function searchVideos(
  admin: SupabaseClient,
  userId: string,
  query: string,
  maxResults = 10
): Promise<Array<{ id: string; title: string; channelTitle: string; publishedAt: string }>> {
  const token = await getGoogleAccessToken(admin, userId, [
    "https://www.googleapis.com/auth/youtube.readonly",
  ]);
  const data = await ytFetch<{
    items?: Array<{ id: { videoId?: string }; snippet: { title: string; channelTitle: string; publishedAt: string } }>;
  }>(
    token,
    `${DATA_BASE}/search?part=snippet&type=video&maxResults=${Math.min(maxResults, 10)}&q=${encodeURIComponent(query)}`
  );
  return (data.items ?? [])
    .map((i) => ({
      id: i.id.videoId ?? "",
      title: i.snippet.title,
      channelTitle: i.snippet.channelTitle,
      publishedAt: i.snippet.publishedAt,
    }))
    .filter((i) => i.id);
}

export interface ChannelAnalytics {
  days: number;
  rows: Array<{ date: string; views: number; watchTimeMinutes: number; subsGained: number }>;
  totals: { views: number; watchTimeMinutes: number; avgViewDurationSeconds: number; subsGained: number };
  /** Set when the Analytics API answered but returned no rows (new/low-traffic channel). */
  empty: boolean;
}

export async function getChannelAnalytics(
  admin: SupabaseClient,
  userId: string,
  days = 28
): Promise<ChannelAnalytics> {
  const token = await getGoogleAccessToken(admin, userId, [
    "https://www.googleapis.com/auth/youtube.readonly",
  ]);

  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const qs = new URLSearchParams({
    ids: "channel==MINE",
    startDate: iso(start),
    endDate: iso(end),
    metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained",
    dimensions: "day",
    sort: "day",
  });

  const data = await ytFetch<{ rows?: unknown[][]; errors?: unknown }>(
    token,
    `${ANALYTICS_BASE}/reports?${qs}`
  );

  const rows = (data.rows ?? []).map((r) => ({
    date: String(r[0]),
    views: Number(r[1] ?? 0),
    watchTimeMinutes: Number(r[2] ?? 0),
    avgDuration: Number(r[3] ?? 0),
    subsGained: Number(r[4] ?? 0),
  }));

  const totals = rows.reduce(
    (acc, r) => ({
      views: acc.views + r.views,
      watchTimeMinutes: acc.watchTimeMinutes + r.watchTimeMinutes,
      subsGained: acc.subsGained + r.subsGained,
      avgDurationSum: acc.avgDurationSum + r.avgDuration,
    }),
    { views: 0, watchTimeMinutes: 0, subsGained: 0, avgDurationSum: 0 }
  );

  return {
    days,
    rows: rows.map(({ date, views, watchTimeMinutes, subsGained }) => ({
      date,
      views,
      watchTimeMinutes,
      subsGained,
    })),
    totals: {
      views: totals.views,
      watchTimeMinutes: totals.watchTimeMinutes,
      avgViewDurationSeconds: rows.length ? Math.round(totals.avgDurationSum / rows.length) : 0,
      subsGained: totals.subsGained,
    },
    empty: rows.length === 0,
  };
}

export interface UploadVideoInput {
  /** Publicly reachable URL of the video file; downloaded server-side. */
  sourceUrl: string;
  title: string;
  description: string;
  tags?: string[];
  privacy: "private" | "unlisted";
  categoryId?: string;
}

/**
 * Resumable upload. Requires the `youtube.upload` scope; throws a ScopeError the agent
 * surfaces as "needs re-authorisation" rather than pretending the upload happened.
 */
export async function uploadVideo(
  admin: SupabaseClient,
  userId: string,
  input: UploadVideoInput
): Promise<{ id: string; privacyStatus: string; verified: boolean }> {
  const token = await getGoogleAccessToken(admin, userId, [
    "https://www.googleapis.com/auth/youtube.upload",
  ]);

  const fileResponse = await fetch(input.sourceUrl, { cache: "no-store" });
  if (!fileResponse.ok) {
    throw new YouTubeError(`Could not download the video file: HTTP ${fileResponse.status}`, 400);
  }
  const bytes = Buffer.from(await fileResponse.arrayBuffer());
  const mimeType = fileResponse.headers.get("content-type") || "video/mp4";

  const metadata = {
    snippet: {
      title: input.title.slice(0, 100),
      description: input.description.slice(0, 5000),
      tags: (input.tags ?? []).slice(0, 30),
      categoryId: input.categoryId ?? "22",
    },
    status: { privacyStatus: input.privacy, selfDeclaredMadeForKids: false },
  };

  // Step 1: initiate resumable session.
  const init = await fetch(
    `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": mimeType,
        "x-upload-content-length": String(bytes.length),
      },
      body: JSON.stringify(metadata),
      cache: "no-store",
    }
  );

  if (!init.ok) {
    const body = await init.text().catch(() => "");
    throw new YouTubeError(
      `YouTube rejected the upload session (HTTP ${init.status}): ${body.slice(0, 300)}`,
      init.status
    );
  }

  const sessionUrl = init.headers.get("location");
  if (!sessionUrl) throw new YouTubeError("YouTube did not return an upload session URL.", 502);

  // Step 2: PUT the bytes.
  const put = await fetch(sessionUrl, {
    method: "PUT",
    headers: {
      "content-type": mimeType,
      "content-length": String(bytes.length),
    },
    body: bytes,
  });
  if (!put.ok) {
    const body = await put.text().catch(() => "");
    throw new YouTubeError(`Video upload failed (HTTP ${put.status}): ${body.slice(0, 300)}`, put.status);
  }

  const created = (await put.json()) as { id?: string; status?: { privacyStatus?: string } };
  if (!created.id) throw new YouTubeError("Upload completed but YouTube returned no video id.", 502);

  // Step 3: verify the video is actually retrievable on the channel.
  const verifyToken = token;
  try {
    const check = await ytFetch<{ items?: Array<{ id: string }> }>(
      verifyToken,
      `${DATA_BASE}/videos?part=id&id=${created.id}`
    );
    return {
      id: created.id,
      privacyStatus: created.status?.privacyStatus ?? input.privacy,
      verified: Boolean(check.items?.length),
    };
  } catch {
    return { id: created.id, privacyStatus: input.privacy, verified: false };
  }
}

export { NotConnectedError };
