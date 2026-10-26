import { z } from "zod";
import { registry, defineTool } from "../registry";
import {
  wpCreatePost,
  wpGetPost,
  wpListComments,
  wpModerateComment,
  wpSearchPosts,
  wpSiteStatus,
  wpUpdatePost,
  resolveWordPressConnection,
  WordPressError,
} from "@/lib/integrations/wordpress";

/**
 * WordPress tools (section 5).
 *
 * Draft-first by default: `wordpress.create_draft` can only ever create status=draft.
 * Going live is a separate `wordpress.publish` tool carrying risk=high and
 * requiresApproval, so the confirmation gate is structural rather than prompt-based.
 */

async function conn(ctx: import("../registry").ToolContext) {
  const client = ctx.admin ?? ctx.db;
  return resolveWordPressConnection(client, ctx.userId);
}

function describe(error: unknown): string {
  if (error instanceof WordPressError) {
    const hints: Record<string, string> = {
      rest_cannot_create: "The application password belongs to a user without permission to create posts.",
      rest_forbidden: "The application password's user lacks permission for this operation.",
      not_configured: (error as Error).message,
      unauthorized: "WordPress rejected the application password — check it under Users → Profile → Application Passwords.",
    };
    return hints[error.wpCode ?? ""] || (error as Error).message;
  }
  return (error as Error).message;
}

const wpSearch = defineTool({
  name: "wordpress.search",
  description:
    "Search posts and pages on the connected WordPress site by keyword, newest first. " +
    "Returns id, status, title, excerpt and link.",
  category: "wordpress",
  risk: "read",
  requiresConnection: "wordpress",
  triggers: ["wordpress", "my site", "blog post", "my website", "wp", "posts on my site"],
  schema: z.object({
    query: z.string().min(1).max(200),
    status: z.enum(["draft", "publish", "pending", "future", "any"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async execute(args, ctx) {
    try {
      const connection = await conn(ctx);
      const posts = await wpSearchPosts(connection, {
        query: args.query,
        status: args.status === "any" ? undefined : args.status,
        perPage: args.limit ?? 10,
      });
      return {
        ok: true,
        data: {
          count: posts.length,
          posts: posts.map((p) => ({
            id: p.id,
            status: p.status,
            title: stripTags(p.title.rendered),
            excerpt: stripTags(p.excerpt?.rendered ?? "").slice(0, 300),
            link: p.link,
            modified_gmt: p.modified_gmt,
          })),
        },
      };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  },
});

const wpCreateDraft = defineTool({
  name: "wordpress.create_draft",
  description:
    "Create a NEW post on the connected WordPress site in draft status. Never publishes. " +
    "Accepts HTML content. Returns the created post id and permalink after verifying it exists.",
  category: "wordpress",
  risk: "write",
  requiresConnection: "wordpress",
  triggers: ["draft a", "write a blog", "create a post", "new blog post", "save it in wordpress"],
  schema: z.object({
    title: z.string().min(1).max(300),
    content_html: z.string().min(1).max(200_000).describe("Post body as HTML"),
    excerpt: z.string().max(1000).optional(),
    categories: z.array(z.number().int()).max(20).optional(),
    tags: z.array(z.number().int()).max(20).optional(),
    slug: z.string().max(200).optional(),
  }),
  async execute(args, ctx) {
    try {
      const connection = await conn(ctx);
      const { post, verified } = await wpCreatePost(connection, {
        title: args.title,
        content: args.content_html,
        excerpt: args.excerpt,
        categories: args.categories,
        tags: args.tags,
        slug: args.slug,
        status: "draft",
      });
      return {
        ok: true,
        verified,
        data: {
          id: post.id,
          status: post.status,
          title: stripTags(post.title.rendered),
          link: post.link,
          verified,
          note: verified
            ? "Confirmed by re-reading the post from WordPress."
            : "WordPress accepted the write but the read-back check did not run — verify manually.",
        },
      };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  },
});

const wpUpdate = defineTool({
  name: "wordpress.update_post",
  description: "Update the title, body, excerpt, slug or status of an existing post or page.",
  category: "wordpress",
  risk: "write",
  requiresConnection: "wordpress",
  triggers: ["edit the post", "update the post", "change the title", "rewrite the post"],
  schema: z.object({
    post_id: z.number().int().positive(),
    title: z.string().max(300).optional(),
    content_html: z.string().max(200_000).optional(),
    excerpt: z.string().max(1000).optional(),
    slug: z.string().max(200).optional(),
    status: z.enum(["draft", "pending", "publish", "future"]).optional(),
  }),
  async execute(args, ctx) {
    try {
      const connection = await conn(ctx);
      const fields: Record<string, string> = {};
      if (args.title !== undefined) fields.title = args.title;
      if (args.content_html !== undefined) fields.content = args.content_html;
      if (args.excerpt !== undefined) fields.excerpt = args.excerpt;
      if (args.slug !== undefined) fields.slug = args.slug;
      if (args.status !== undefined) fields.status = args.status;
      if (!Object.keys(fields).length) return { ok: false, error: "No fields supplied to update." };

      const { post, verified } = await wpUpdatePost(connection, args.post_id, fields);
      return {
        ok: true,
        verified,
        data: { id: post.id, status: post.status, link: post.link, verified },
      };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  },
});

const wpPublish = defineTool({
  name: "wordpress.publish",
  description:
    "Publish a draft post to the live site. HIGH IMPACT: this makes content public. " +
    "Always requires explicit user confirmation immediately before running.",
  category: "wordpress",
  risk: "high",
  requiresConnection: "wordpress",
  requiresApproval: true,
  triggers: ["publish the post", "make it live", "publish to wordpress"],
  schema: z.object({
    post_id: z.number().int().positive(),
    date: z.string().optional().describe("Schedule instead: ISO-8601 local time for a future post"),
  }),
  async execute(args, ctx) {
    try {
      const connection = await conn(ctx);
      const before = await wpGetPost(connection, args.post_id);
      const { post, verified } = await wpUpdatePost(connection, args.post_id, {
        status: args.date ? "future" : "publish",
        ...(args.date ? { date: args.date } : {}),
      });
      return {
        ok: true,
        verified: verified && post.status !== before.status,
        data: {
          id: post.id,
          previous_status: before.status,
          status: post.status,
          link: post.link,
          scheduled_for: args.date ?? null,
        },
      };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  },
});

const wpComments = defineTool({
  name: "wordpress.comments",
  description:
    "List comments (optionally by status or post) or moderate one comment by id. " +
    "Moderation is reversible in WordPress, so approving/holding runs without confirmation; " +
    "moving to trash is destructive and will ask first.",
  category: "wordpress",
  risk: "write",
  requiresConnection: "wordpress",
  triggers: ["comments", "moderate", "approve comment", "spam comment"],
  schema: z.object({
    action: z.enum(["list", "approve", "hold", "spam", "trash"]),
    comment_id: z.number().int().positive().optional(),
    post_id: z.number().int().positive().optional(),
    status: z.enum(["hold", "approved", "spam", "trash"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async execute(args, ctx) {
    try {
      const connection = await conn(ctx);
      if (args.action === "list") {
        const comments = await wpListComments(connection, {
          status: args.status,
          postId: args.post_id,
          perPage: args.limit ?? 20,
        });
        return {
          ok: true,
          data: {
            count: comments.length,
            comments: comments.map((c) => ({
              id: c.id,
              post: c.post,
              status: c.status,
              author: c.author_name,
              excerpt: stripTags(c.content.rendered).slice(0, 300),
              date_gmt: c.date_gmt,
            })),
          },
        };
      }
      if (!args.comment_id) return { ok: false, error: "comment_id is required to moderate." };
      const statusMap = { approve: "approved", hold: "hold", spam: "spam", trash: "trash" } as const;
      const { comment, verified } = await wpModerateComment(connection, args.comment_id, statusMap[args.action]);
      return { ok: true, verified, data: { id: comment.id, status: comment.status, verified } };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  },
});

const wpStatus = defineTool({
  name: "wordpress.site_status",
  description:
    "Check that the connected WordPress site is reachable and report its name, URL and " +
    "available REST namespaces. Useful for verifying a connection before writing.",
  category: "wordpress",
  risk: "read",
  requiresConnection: "wordpress",
  triggers: ["site status", "is my site up", "check wordpress", "wordpress connection"],
  schema: z.object({}),
  async execute(_args, ctx) {
    try {
      const connection = await conn(ctx);
      const status = await wpSiteStatus(connection);
      return { ok: status.ok, data: { ...status, siteUrl: connection.siteUrl, username: connection.username } };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  },
});

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function registerWordPressTools(): void {
  registry.registerAll([wpSearch, wpCreateDraft, wpUpdate, wpPublish, wpComments, wpStatus]);
}
