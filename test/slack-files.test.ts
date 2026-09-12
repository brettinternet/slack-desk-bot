import { describe, expect, mock, test } from "bun:test";
import type { App } from "@slack/bolt";
import { ingestSlackFiles, SLACK_FILE_LIMITS } from "../src/slack-files.ts";

function slackClient(file: Record<string, unknown>): App["client"] {
  return {
    files: { info: mock(async () => ({ ok: true, file })) },
  } as unknown as App["client"];
}

function slackFile(overrides: Record<string, unknown> = {}) {
  return {
    id: "F1",
    name: "notes.txt",
    mimetype: "text/plain",
    size: 5,
    url_private_download: "https://files.slack.com/files-pri/T1-F1/download/notes.txt",
    ...overrides,
  };
}

describe("Slack file ingestion", () => {
  test("downloads and decodes supported text files", async () => {
    const fetcher = mock(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.headers).toEqual({ authorization: "Bearer xoxb-test" });
      expect(init?.redirect).toBe("error");
      return new Response("hello", { headers: { "content-length": "5" } });
    }) as unknown as typeof fetch;

    expect(
      await ingestSlackFiles(slackClient(slackFile()), "xoxb-test", [{ id: "F1" }], fetcher),
    ).toEqual({
      attachments: [
        {
          kind: "text",
          name: "notes.txt",
          mediaType: "text/plain",
          text: "hello",
        },
      ],
      warnings: [],
    });
  });

  test("encodes images after checking their signature", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetcher = mock(async () => new Response(png)) as unknown as typeof fetch;
    const result = await ingestSlackFiles(
      slackClient(slackFile({ name: "image.png", mimetype: "image/png", size: png.length })),
      "xoxb-test",
      [{ id: "F1" }],
      fetcher,
    );

    expect(result.warnings).toEqual([]);
    expect(result.attachments).toEqual([
      {
        kind: "image",
        name: "image.png",
        mediaType: "image/png",
        data: Buffer.from(png).toString("base64"),
      },
    ]);
  });

  test("rejects unsafe names, unsupported types, hosts, and mismatched images", async () => {
    const cases = [
      slackFile({ name: "../secret.txt" }),
      slackFile({ mimetype: "application/zip" }),
      slackFile({ url_private_download: "https://example.com/file" }),
      slackFile({ name: "image.png", mimetype: "image/png" }),
    ];
    const fetcher = mock(async () => new Response("hello")) as unknown as typeof fetch;

    for (const file of cases) {
      const result = await ingestSlackFiles(
        slackClient(file),
        "xoxb-test",
        [{ id: "F1" }],
        fetcher,
      );
      expect(result.attachments).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    }
  });

  test("enforces the actual streamed size when metadata is inaccurate", async () => {
    const body = new Uint8Array(SLACK_FILE_LIMITS.maxTextBytes + 1);
    const fetcher = mock(async () => new Response(body)) as unknown as typeof fetch;
    const result = await ingestSlackFiles(
      slackClient(slackFile({ size: 1 })),
      "xoxb-test",
      [{ id: "F1" }],
      fetcher,
    );

    expect(result.attachments).toEqual([]);
    expect(result.warnings[0]).toContain("exceeds");
  });

  test("limits the number of files before requesting their metadata", async () => {
    const info = mock(async () => ({ ok: true, file: slackFile() }));
    const client = { files: { info } } as unknown as App["client"];
    const fetcher = mock(async () => new Response("hello")) as unknown as typeof fetch;
    const files = Array.from({ length: SLACK_FILE_LIMITS.maxFiles + 1 }, (_, index) => ({
      id: `F${index}`,
    }));

    const result = await ingestSlackFiles(client, "xoxb-test", files, fetcher);
    expect(info).toHaveBeenCalledTimes(SLACK_FILE_LIMITS.maxFiles);
    expect(result.warnings.at(-1)).toContain("at most 4 files");
  });
});
