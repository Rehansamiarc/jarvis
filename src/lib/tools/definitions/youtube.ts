import { z } from "zod";
import { registry, defineTool } from "../registry";
import {
  getChannel,
  getChannelAnalytics,
  listVideos,
  searchVideos,
  uploadVideo,
  YouTubeError,
} from "@/lib/integrations/youtube";
import { generateText } from "@/lib/ai/generate";
import { ScopeError } from "@/lib/integrations/connections";

function describe(error: unknown): string {
  if (error instanceof ScopeError) return (error as Error).message;
  if (error instanceof YouTubeError) {
    const quota = error.reason === "quotaExceeded" || error.status === 403;
    if (quota) {
      return (
        "YouTube API quota exceeded for today, or the connected account lacks permission. " +
        `Reason: ${error.reason ?? "unknown"}. Try again after the daily quota reset (Pacific time).`
      );
    }
    if (error.status === 401) {
      return "Google access token was rejected — reconnect YouTube in Settings → Connected accounts.";
    }
    return (error as Error).message;
  }
  return (error as Error).message;
}

function admin(ctx: import("../registry").ToolContext) {
  if (!ctx.admin) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not configured on the server, so stored Google OAuth " +
        "tokens cannot be read. Set it (see .env.example) or reconnect Google with an env-based flow."
    );
  }
  return ctx.admin;
}

const ytChannel = defineTool({
  name: "youtube.channel",
  description: "Return the connected YouTube channel: id, title, description, subscribers, views and video count.",
  category: "youtube",
  risk: "read",
  requiresConnection: "youtube",
  triggers: ["my channel", "youtube channel", "subscribers", "channel stats"],
  schema: z.object({}),
  async execute(_args, ctx) {
    try {
      return { ok: true, verified: true, data: await getChannel(admin(ctx), ctx.userId) };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  },
});

const ytVideos = defineTool({
  name: "youtube.videos",
  description:
    "List the connected channel's uploads (newest first, cheap on quota). Pass `query` to run " +
    "a keyword search instead, which costs 100 quota units — prefer listing when possible.",
  category: "youtube",
  risk: "read",
  requiresConnection: "youtube",
  triggers: ["my videos", "uploaded videos", "recent videos", "video performance", "which topics"],
  schema: z.object({
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async execute(args, ctx) {
    try {
      const client = admin(ctx);
      if (args.query) {
        const items = await searchVideos(client, ctx.userId, args.query, Math.min(args.limit ?? 10, 10));
        return { ok: true, data: { mode: "search", count: items.length, videos: items } };
      }
      const videos = await listVideos(client, ctx.userId, { maxResults: args.limit ?? 25 });
      const sorted = [...videos].sort((a, b) => b.viewCount - a.viewCount);
      return {
        ok: true,
        verified: true,
        data: {
          mode: "uploads",
          count: videos.length,
          top_performers: sorted.slice(0, 5).map((v) => ({
            id: v.id,
            title: v.title,
            views: v.viewCount,
            likes: v.likeCount,
            publishedAt: v.publishedAt,
          })),
          videos,
        },
      };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  },
});

const ytAnalytics = defineTool({
  name: "youtube.analytics",
  description:
    "Retrieve channel analytics for a date range from the YouTube Analytics API: daily views, " +
    "watch-time minutes and subscribers gained. Returns totals and an empty flag when the " +
    "channel has no data in range (rather than inventing numbers).",
  category: "youtube",
  risk: "read",
  requiresConnection: "youtube",
  triggers: ["analytics", "watch time", "views over", "performance report", "how are my videos"],
  schema: z.object({
    days: z.number().int().min(7).max(365).default(28),
  }),
  async execute(args, ctx) {
    try {
      const data = await getChannelAnalytics(admin(ctx), ctx.userId, args.days);
      return {
        ok: true,
        verified: true,
        data: {
          ...data,
          note: data.empty
            ? "The Analytics API returned no rows for this range — the channel may be new or below the reporting threshold."
            : undefined,
        },
      };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  },
});

const ytMetadataDraft = defineTool({
  name: "youtube.metadata_draft",
  description:
    "Generate a SEO-ready title, description, tag set and chapter outline for a planned video. " +
    "Returns a draft only — it does not touch YouTube.",
  category: "youtube",
  risk: "write",
  requiresConnection: "youtube",
  triggers: ["prepare a title", "video description", "content plan", "next video", "metadata for"],
  schema: z.object({
    topic: z.string().min(3).max(500),
    duration_minutes: z.number().int().min(1).max(600).optional(),
    tone: z.string().max(120).optional(),
  }),
  async execute(args, ctx) {
    try {
      // Give the model the channel's real recent titles so the draft matches its voice.
      let recent: Array<{ title: string; viewCount: number; publishedAt: string }> = [];
      try {
        const videos = await listVideos(admin(ctx), ctx.userId, { maxResults: 8 });
        recent = videos.map((v) => ({
          title: v.title,
          viewCount: v.viewCount,
          publishedAt: v.publishedAt,
        }));
      } catch {
        /* channel context is optional */
      }

      const raw = await generateText(ctx.db, ctx.userId, {
        role: "primary",
        json: true,
        system:
          "You are a YouTube metadata specialist. Respond with JSON only, no prose, matching:\n" +
          '{"title":string,"description":string,"tags":string[],"chapters":[{"time":string,"label":string}],"thumbnail_text":string}\n' +
          "Rules: title <= 70 characters, front-load the main keyword, description opens with a " +
          "2-sentence hook then includes timestamps, 12-20 tags mixing broad and specific phrases.",
        prompt: JSON.stringify({
          topic: args.topic,
          duration_minutes: args.duration_minutes ?? 10,
          tone: args.tone ?? "conversational, no clickbait",
          recent_channel_titles: recent,
        }),
        maxTokens: 1400,
        temperature: 0.8,
      });

      const parsed = parseJsonLoose(raw);
      return { ok: true, data: { ...parsed, source: "generated_draft", applied: false } };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  },
});

const ytUpload = defineTool({
  name: "youtube.upload",
  description:
    "Upload a video file from a URL to the connected YouTube channel as private or unlisted. " +
    "HIGH IMPACT and quota-heavy — always requires explicit confirmation, and requires the " +
    "youtube.upload OAuth scope to have been granted.",
  category: "youtube",
  risk: "high",
  requiresConnection: "youtube",
  requiresApproval: true,
  triggers: ["upload this video", "upload video to youtube"],
  schema: z.object({
    source_url: z.string().url().describe("Publicly reachable URL of the video file"),
    title: z.string().min(1).max(100),
    description: z.string().max(5000).default(""),
    tags: z.array(z.string().max(60)).max(30).optional(),
    privacy: z.enum(["private", "unlisted"]).default("private"),
  }),
  async execute(args, ctx) {
    try {
      const result = await uploadVideo(admin(ctx), ctx.userId, {
        sourceUrl: args.source_url,
        title: args.title,
        description: args.description,
        tags: args.tags,
        privacy: args.privacy,
      });
      return {
        ok: true,
        verified: result.verified,
        data: {
          id: result.id,
          privacy: result.privacyStatus,
          verified: result.verified,
          watch_url: `https://studio.youtube.com/video/${result.id}/edit`,
        },
      };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  },
});

function parseJsonLoose(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    return { raw_output: raw };
  }
}

export function registerYouTubeTools(): void {
  registry.registerAll([ytChannel, ytVideos, ytAnalytics, ytMetadataDraft, ytUpload]);
}
