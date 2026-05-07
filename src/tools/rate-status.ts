import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { READ } from "./_register.js";

/**
 * Read-only operator view of how close we are to Meta's throttles, which
 * circuits are open, and which access tier we're on. Useful both for agents
 * deciding whether to batch vs. retry and for humans investigating slowness.
 */
export function registerRateStatusTools(server: McpServer): void {
  server.registerTool(
    "ads_rate_status",
    {
      description:
        "Show the current Meta API rate-limit usage across tokens, accounts, and use-case types, plus any open circuits and the write-pacer state. Does NOT call Meta — returns in-process state.",
      inputSchema: {},
      annotations: { ...READ },
    },
    async () => {
      const { usage, circuits, writePacer } = metaApiClient.getUsageSnapshot();

      if (usage.length === 0 && circuits.length === 0 && writePacer.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No Meta API usage recorded yet in this process.",
            },
          ],
        };
      }

      const now = Date.now();
      const lines: string[] = [];

      if (circuits.length > 0) {
        lines.push("🚨 OPEN CIRCUITS (requests blocked):");
        for (const c of circuits) {
          const sec = Math.ceil((c.openUntil - now) / 1000);
          lines.push(
            `  • ${c.key} — ${c.reason} — ${sec}s remaining — trips: ${c.tripCount}${c.lastError ? ` — last: ${c.lastError}` : ""}`,
          );
        }
        lines.push("");
      } else {
        lines.push("✓ No open circuits.");
        lines.push("");
      }

      if (usage.length > 0) {
        lines.push("Usage buckets (% of quota):");
        for (const b of usage) {
          const maxPct = Math.max(b.callCount, b.cpuTime, b.totalTime);
          const retry =
            b.estimatedTimeToRegainAccessMs > 0
              ? ` | retry-after: ${Math.round(b.estimatedTimeToRegainAccessMs / 1000)}s`
              : "";
          const tier = b.adsApiAccessTier ? ` | tier: ${b.adsApiAccessTier}` : "";
          lines.push(
            `  • [${b.kind}] ${b.key} — call:${b.callCount}% cpu:${b.cpuTime}% time:${b.totalTime}% (max ${maxPct}%)${retry}${tier}`,
          );
        }
        lines.push("");
      }

      if (writePacer.length > 0) {
        lines.push("Write pacer (Ads Management token-bucket):");
        for (const w of writePacer) {
          lines.push(
            `  • ${w.key} — ${w.tokens}/${w.capacity} tokens | ${w.rateRps} rps | tier: ${w.tier}`,
          );
        }
      }

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify({ usage, circuits, writePacer }, null, 2) },
        ],
      };
    },
  );
}
