import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type LlmConfig } from "../src/config";
import {
  LLM_ENVIRONMENT_FIELDS,
  parseLlmSettingsUpdate,
  publicLlmSettings,
  readStoredSettings,
  settingsPath,
  writeStoredLlmSettings,
} from "../src/settings";

function llm(values: Partial<LlmConfig> = {}): LlmConfig {
  return {
    mode: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen-worklog",
    apiKey: "stored-secret",
    allowRemote: false,
    timeoutMs: 30_000,
    maxInputChars: 12_000,
    maxSessionsPerScan: 12,
    retryFailed: false,
    ...values,
  };
}

async function withCleanLlmEnvironment(run: () => void | Promise<void>): Promise<void> {
  const names = ["WORKLOG_DATA_DIR", ...Object.keys(LLM_ENVIRONMENT_FIELDS)];
  const before = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    await run();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("LLM settings", () => {
  test("persists private settings with 0600 permissions and never exposes the API key", async () => {
    await withCleanLlmEnvironment(() => {
      const root = mkdtempSync(join(tmpdir(), "agent-worklog-settings-"));
      try {
        writeStoredLlmSettings(root, llm());
        expect(statSync(settingsPath(root)).mode & 0o777).toBe(0o600);
        const stored = readStoredSettings(root).llm;
        expect(stored?.apiKey).toBe("stored-secret");

        process.env.WORKLOG_DATA_DIR = root;
        const config = loadConfig();
        const safe = publicLlmSettings(config.llm, root);
        expect(safe.hasApiKey).toBe(true);
        expect(safe.source).toBe("file");
        expect(JSON.stringify(safe)).not.toContain("stored-secret");
        expect("apiKey" in safe).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test("keeps an existing key for blank input and only clears it explicitly", () => {
    const base = {
      ...llm(),
      apiKey: "",
      clearApiKey: false,
    };
    expect(parseLlmSettingsUpdate(base, "existing-key").apiKey).toBe("existing-key");
    expect(parseLlmSettingsUpdate({ ...base, clearApiKey: true }, "existing-key").apiKey).toBeUndefined();
  });

  test("environment variables override file settings field by field", async () => {
    await withCleanLlmEnvironment(() => {
      const root = mkdtempSync(join(tmpdir(), "agent-worklog-settings-env-"));
      try {
        writeStoredLlmSettings(root, llm({ model: "file-model", maxSessionsPerScan: 9 }));
        process.env.WORKLOG_DATA_DIR = root;
        process.env.WORKLOG_LLM_MODEL = "environment-model";
        process.env.WORKLOG_LLM_MAX_SESSIONS_PER_SCAN = "3";
        const config = loadConfig();
        expect(config.llm.model).toBe("environment-model");
        expect(config.llm.maxSessionsPerScan).toBe(3);
        expect(config.llm.baseUrl).toBe("http://127.0.0.1:11434/v1");
        expect(publicLlmSettings(config.llm, root).environmentOverrides).toEqual(["model", "maxSessionsPerScan"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
