import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

const settingsPath = join(import.meta.dir, "..", ".pi", "settings.json");

/** Apply only the service's model choice, never project resources or permissions. */
export function applyServicePiModel(settings: SettingsManager, path = settingsPath): void {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const config: unknown = JSON.parse(contents);
  if (
    !config ||
    typeof config !== "object" ||
    !("defaultProvider" in config) ||
    !("defaultModel" in config) ||
    typeof config.defaultProvider !== "string" ||
    !config.defaultProvider.trim() ||
    typeof config.defaultModel !== "string" ||
    !config.defaultModel.trim()
  ) {
    throw new Error("Service Pi model settings must specify defaultProvider and defaultModel");
  }
  settings.applyOverrides({
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
  });
}
