import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import {
  INSTAGRAM_ACCOUNT_FIELDS,
  INSTAGRAM_MEDIA_DEFAULT_FIELDS,
} from "../meta/types/instagram.js";
import type {
  InstagramAccount,
  InstagramMedia,
  MetaApiResponse,
} from "../meta/types/index.js";

export function registerInstagramTools(server: McpServer): void {
  // ─── Get Instagram Business Account ────────────────────────
  server.tool(
    "meta_ads_get_instagram_account",
    "Get the Instagram Business account linked to a Facebook Page. Returns the Instagram account ID needed for creating ad creatives with Instagram placement.",
    {
      page_id: z.string().describe("Facebook Page ID to look up its linked Instagram Business account"),
    },
    async ({ page_id }) => {
      // Request the page with nested instagram_business_account fields
      const nestedFields = INSTAGRAM_ACCOUNT_FIELDS.join(",");
      const result = await metaApiClient.get<{
        instagram_business_account?: InstagramAccount;
        id: string;
      }>(`/${page_id}`, {
        fields: `instagram_business_account{${nestedFields}}`,
      });

      const ig = result.instagram_business_account;

      if (!ig) {
        return {
          content: [
            {
              type: "text",
              text: `No Instagram Business account linked to Page ${page_id}. Ensure the Page has an Instagram Business or Creator account connected in Page Settings.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Instagram Business Account found!\nID: ${ig.id}\nUsername: ${ig.username ?? "N/A"}\nName: ${ig.name ?? "N/A"}\nFollowers: ${ig.followers_count ?? "N/A"}\nMedia count: ${ig.media_count ?? "N/A"}\n\nUse this ID (${ig.id}) as the instagram_actor_id parameter when creating creatives. The MCP maps it to the correct API field automatically (instagram_actor_id inside object_story_spec, instagram_user_id at top-level for source_instagram_media_id / object_story_id modes).`,
          },
          { type: "text", text: JSON.stringify(ig, null, 2) },
        ],
      };
    },
  );

  // ─── Get Instagram Media ───────────────────────────────────
  server.tool(
    "meta_ads_get_instagram_media",
    "List recent media posts from an Instagram Business account. Returns media IDs that can be used with source_instagram_media_id in create_ad_creative to promote existing posts.",
    {
      instagram_account_id: z.string().describe("Instagram Business account ID (from get_instagram_account)"),
      limit: z.number().min(1).max(100).default(25).describe("Number of posts to return"),
    },
    async ({ instagram_account_id, limit }) => {
      const fieldsParam = [...INSTAGRAM_MEDIA_DEFAULT_FIELDS].join(",");

      const response = await metaApiClient.get<MetaApiResponse<InstagramMedia>>(
        `/${instagram_account_id}/media`,
        { fields: fieldsParam, limit },
      );

      const media = response.data ?? [];

      const text =
        media.length === 0
          ? "No media found for this Instagram account."
          : media
              .map(
                (m) =>
                  `• ${m.id} — ${m.media_type ?? "UNKNOWN"}${m.boost_eligibility_info ? ` — Boost: ${m.boost_eligibility_info.eligible_to_boost ? "✅ Eligible" : `❌ ${m.boost_eligibility_info.reason ?? "Not eligible"}`}` : ""} — ${m.caption ? m.caption.substring(0, 80) + (m.caption.length > 80 ? "..." : "") : "No caption"} — ${m.timestamp ?? ""}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${media.length} media post(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(media, null, 2) },
        ],
      };
    },
  );
}
