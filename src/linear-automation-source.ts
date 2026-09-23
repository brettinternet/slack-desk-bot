import type { AutomationSource, Observation } from "./automations.ts";
import type { McpContextProvider } from "./mcp-context.ts";

export function linearIssueSource(provider: McpContextProvider): AutomationSource {
  return {
    fields: ["status", "statusType"],
    validId: (id) => /^[A-Za-z0-9_-]+-\d+$/.test(id),
    async read(id: string): Promise<Observation> {
      const issue: unknown = await provider.callJson("linear", "get_issue", { id });
      if (!issue || typeof issue !== "object") throw new Error("Invalid Linear issue response");
      const value = issue as Record<string, unknown>;
      if (
        typeof value.id !== "string" ||
        value.id.toUpperCase() !== id.toUpperCase() ||
        typeof value.status !== "string" ||
        typeof value.statusType !== "string"
      )
        throw new Error("Invalid Linear issue response");
      return {
        fields: { status: value.status, statusType: value.statusType },
        url:
          typeof value.url === "string" && /^https:\/\/linear\.app\/[^\s<>]+$/.test(value.url)
            ? value.url
            : `https://linear.app/issue/${encodeURIComponent(value.id)}`,
      };
    },
  };
}
