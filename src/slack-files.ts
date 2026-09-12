import type { App } from "@slack/bolt";
import type { AgentAttachment, ImageMediaType } from "./agent.ts";

export const SLACK_FILE_LIMITS = {
  maxFiles: 4,
  maxTextBytes: 1 * 1024 * 1024,
  maxImageBytes: 5 * 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
  maxFilenameLength: 255,
  maxUrlLength: 2_048,
  downloadTimeoutMs: 30_000,
} as const;

const TEXT_MEDIA_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
]);
const IMAGE_MEDIA_TYPES = new Set<ImageMediaType>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

interface SlackFileReference {
  id?: string;
}

interface SlackFileInfo {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

export interface SlackFileIngestionResult {
  attachments: AgentAttachment[];
  warnings: string[];
}

export async function ingestSlackFiles(
  client: App["client"],
  botToken: string,
  files: readonly SlackFileReference[],
  fetchImpl: typeof fetch = fetch,
): Promise<SlackFileIngestionResult> {
  const attachments: AgentAttachment[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;

  for (const [index, reference] of files.entries()) {
    if (index >= SLACK_FILE_LIMITS.maxFiles) {
      warnings.push(
        `Ignored additional file: at most ${SLACK_FILE_LIMITS.maxFiles} files are allowed.`,
      );
      break;
    }
    if (!reference.id) {
      warnings.push("Ignored a file without a Slack file ID.");
      continue;
    }

    try {
      const response = await client.files.info({ file: reference.id });
      const file = response.file as SlackFileInfo | undefined;
      if (!file) throw new Error("Slack returned no file metadata");

      const name = validateFilename(file.name);
      const mediaType = normalizeMediaType(file.mimetype);
      const byteLimit = byteLimitFor(mediaType);
      if (!Number.isSafeInteger(file.size) || file.size! < 0) {
        throw new Error("Slack returned an invalid file size");
      }
      if (file.size! > byteLimit) throw new Error(`file exceeds the ${byteLimit}-byte limit`);
      if (totalBytes + file.size! > SLACK_FILE_LIMITS.maxTotalBytes) {
        throw new Error(`files exceed the ${SLACK_FILE_LIMITS.maxTotalBytes}-byte total limit`);
      }

      const url = validateDownloadUrl(file.url_private_download ?? file.url_private);
      const downloadLimit = Math.min(byteLimit, SLACK_FILE_LIMITS.maxTotalBytes - totalBytes);
      const downloaded = await downloadFile(url, botToken, downloadLimit, fetchImpl);
      if (totalBytes + downloaded.byteLength > SLACK_FILE_LIMITS.maxTotalBytes) {
        throw new Error(`files exceed the ${SLACK_FILE_LIMITS.maxTotalBytes}-byte total limit`);
      }

      if (IMAGE_MEDIA_TYPES.has(mediaType as ImageMediaType)) {
        const imageMediaType = mediaType as ImageMediaType;
        validateImageSignature(downloaded, imageMediaType);
        attachments.push({
          kind: "image",
          name,
          mediaType: imageMediaType,
          data: Buffer.from(downloaded).toString("base64"),
        });
      } else {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(downloaded);
        if (text.includes("\0")) throw new Error("text file contains a NUL byte");
        attachments.push({ kind: "text", name, mediaType, text });
      }
      totalBytes += downloaded.byteLength;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Ignored Slack file ${reference.id}: ${message}.`);
    }
  }

  return { attachments, warnings };
}

function validateFilename(value: string | undefined): string {
  if (!value) throw new Error("file has no name");
  if (
    value.length > SLACK_FILE_LIMITS.maxFilenameLength ||
    value === "." ||
    value === ".." ||
    /[\\/\0-\x1f\x7f]/.test(value)
  ) {
    throw new Error("file name is unsafe or too long");
  }
  return value;
}

function normalizeMediaType(value: string | undefined): string {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    !mediaType ||
    (!TEXT_MEDIA_TYPES.has(mediaType) && !IMAGE_MEDIA_TYPES.has(mediaType as ImageMediaType))
  ) {
    throw new Error(`unsupported MIME type ${value ?? "unknown"}`);
  }
  return mediaType;
}

function byteLimitFor(mediaType: string): number {
  return IMAGE_MEDIA_TYPES.has(mediaType as ImageMediaType)
    ? SLACK_FILE_LIMITS.maxImageBytes
    : SLACK_FILE_LIMITS.maxTextBytes;
}

function validateDownloadUrl(value: string | undefined): URL {
  if (!value || value.length > SLACK_FILE_LIMITS.maxUrlLength) {
    throw new Error("file download URL is missing or too long");
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "files.slack.com" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new Error("file download URL is not an approved Slack URL");
  }
  return url;
}

async function downloadFile(
  url: URL,
  botToken: string,
  limit: number,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${botToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(SLACK_FILE_LIMITS.downloadTimeoutMs),
  });
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new Error("download returned an invalid Content-Length");
    }
    if (declared > limit) throw new Error(`file exceeds the ${limit}-byte limit`);
  }
  if (!response.body) throw new Error("download returned no content");

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(`file exceeds the ${limit}-byte limit`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function validateImageSignature(data: Uint8Array, mediaType: ImageMediaType): void {
  const startsWith = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte);
  const valid =
    (mediaType === "image/png" && startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) ||
    (mediaType === "image/jpeg" && startsWith(0xff, 0xd8, 0xff)) ||
    (mediaType === "image/gif" &&
      (startsWith(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) ||
        startsWith(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) ||
    (mediaType === "image/webp" &&
      startsWith(0x52, 0x49, 0x46, 0x46) &&
      data[8] === 0x57 &&
      data[9] === 0x45 &&
      data[10] === 0x42 &&
      data[11] === 0x50);
  if (!valid) throw new Error(`content does not match ${mediaType}`);
}
