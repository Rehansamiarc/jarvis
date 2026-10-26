import "server-only";
import { env } from "@/lib/env";

/**
 * Server-side web search (Serper). The browser never calls this provider directly, so
 * the API key stays server-side. When no key is configured the tool reports the missing
 * configuration instead of inventing results.
 */

export interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

export class SearchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchUnavailableError";
  }
}

export async function webSearch(
  query: string,
  numResults = 6
): Promise<{ results: SearchResult[]; searchTimeMs: number }> {
  const apiKey = env().SERPER_API_KEY;
  if (!apiKey) {
    throw new SearchUnavailableError(
      "Web search is not configured. Set SERPER_API_KEY on the server (https://serper.dev) " +
        "to enable the web_search tool."
    );
  }

  const started = Date.now();
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ q: query, num: Math.min(numResults, 10) }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new SearchUnavailableError(
      `Web search provider returned HTTP ${response.status}: ${text.slice(0, 200)}`
    );
  }

  const json = (await response.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
    answerBox?: { answer?: string; snippet?: string; title?: string };
  };

  const results: SearchResult[] = (json.organic ?? [])
    .slice(0, numResults)
    .map((r) => ({
      title: r.title ?? "",
      link: r.link ?? "",
      snippet: r.snippet ?? "",
    }))
    .filter((r) => r.link);

  return { results, searchTimeMs: Date.now() - started };
}
