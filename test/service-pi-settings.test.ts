import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { applyServicePiModel } from "../src/service-pi-settings.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function settingsFile(contents: object): string {
  const directory = mkdtempSync(join(tmpdir(), "slack-pi-settings-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "settings.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe("service Pi model", () => {
  test("overrides the global default without trusting other project settings", () => {
    const settings = SettingsManager.inMemory(
      { defaultProvider: "openrouter", defaultModel: "old" },
      { projectTrusted: false },
    );
    const path = settingsFile({
      defaultProvider: "openrouter",
      defaultModel: "anthropic/claude-opus-5",
      extensions: ["untrusted.ts"],
    });

    applyServicePiModel(settings, path);

    expect(settings.getDefaultModel()).toBe("anthropic/claude-opus-5");
    expect(settings.getGlobalSettings().defaultModel).toBe("old");
    expect(settings.getProjectSettings()).toEqual({});
    expect(settings.isProjectTrusted()).toBe(false);
  });

  test("rejects incomplete model settings", () => {
    const settings = SettingsManager.inMemory();
    const path = settingsFile({ defaultModel: "anthropic/claude-opus-5" });
    expect(() => applyServicePiModel(settings, path)).toThrow("defaultProvider and defaultModel");
  });
});
