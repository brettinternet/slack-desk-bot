import type { AgentAttachment } from "./agent.ts";

export function prepareTextPrompt(
  parts: readonly (string | undefined)[],
  attachments: readonly AgentAttachment[] = [],
  fallback: string,
): string {
  const files = attachments
    .filter((attachment) => attachment.kind === "text")
    .map((attachment) =>
      [
        `<slack-file name=${JSON.stringify(attachment.name)} media-type=${JSON.stringify(attachment.mediaType)}>`,
        attachment.text,
        "</slack-file>",
      ].join("\n"),
    );
  return [...parts.map((part) => part?.trim()), ...files].filter(Boolean).join("\n\n") || fallback;
}
