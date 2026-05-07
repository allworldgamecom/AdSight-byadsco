import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ } from "./_register.js";
import helpArticles from "../data/help-articles.json" with { type: "json" };

interface HelpArticle {
  id: string;
  title: string;
  url: string;
  summary: string;
  tags: string[];
}

const ARTICLES = helpArticles as HelpArticle[];

export function registerHelpTools(server: McpServer): void {
  // ─── Help Article Search ─────────────────────────────────────
  server.registerTool(
    "ads_get_help_article",
    {
      description:
        "Search Meta Business Help Center articles by query. Returns curated articles relevant to common workflows: rejections, pixel/CAPI setup, audience requirements, billing, learning phase, ad rankings, etc. Mirrors the official Meta MCP tool. Backed by a curated dataset, not a live API — for the most current article, follow the returned URL.",
      inputSchema: {
        query: z.string().min(1).describe("Search query (e.g., 'why was my ad rejected', 'pixel setup', 'lookalike requirements')"),
        limit: z.number().min(1).max(20).default(5),
      },
      annotations: { ...READ },
    },
    async ({ query, limit }) => {
      const tokens = tokenize(query);
      const scored = ARTICLES.map((article) => ({
        article,
        score: scoreArticle(article, tokens),
      }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (scored.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No matching articles found for "${query}". Try broader keywords or check developers.facebook.com/docs/marketing-api directly.`,
            },
          ],
        };
      }

      const lines = [
        `${scored.length} article(s) for "${query}":`,
        "",
        ...scored.map(({ article }) => [
          `• ${article.title}`,
          `  ${article.summary}`,
          `  ${article.url}`,
        ].join("\n")),
      ];

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          {
            type: "text",
            text: JSON.stringify(scored.map((s) => s.article), null, 2),
          },
        ],
      };
    },
  );
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3);
}

function scoreArticle(article: HelpArticle, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const titleLower = article.title.toLowerCase();
  const summaryLower = article.summary.toLowerCase();
  const tagsLower = article.tags.map((t) => t.toLowerCase());

  let score = 0;
  for (const tok of queryTokens) {
    if (tagsLower.includes(tok)) score += 4;
    if (titleLower.includes(tok)) score += 3;
    if (summaryLower.includes(tok)) score += 1;
  }
  return score;
}
