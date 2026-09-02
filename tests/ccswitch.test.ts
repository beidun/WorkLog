import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCcswitchConfig } from "../src/ccswitch";

describe("ccswitch provider discovery", () => {
  test("reads the selected Codex Responses provider without exposing it in the projection", () => {
    const root = mkdtempSync(join(tmpdir(), "worklog-ccswitch-"));
    try {
      const dbPath = join(root, "cc-switch.db");
      const db = new Database(dbPath);
      db.run("CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, is_current INTEGER, meta TEXT, created_at INTEGER)");
      db.query("INSERT INTO providers VALUES (?,?,?,?,?,?,?)").run(
        "current", "codex", "Current Codex", JSON.stringify({
          auth: { OPENAI_API_KEY: "test-secret" },
          config: "model = \"gpt-test\"\n[model_providers.custom]\nbase_url = \"https://models.example/v1\"\nwire_api = \"responses\"\n",
        }), 1, JSON.stringify({ apiFormat: "openai_responses" }), 1,
      );
      db.close();
      const result = discoverCcswitchConfig(root);
      expect(result).toMatchObject({ providerId: "current", providerName: "Current Codex", model: "gpt-test", baseUrl: "https://models.example/v1", protocol: "responses", mode: "remote", apiKey: "test-secret" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores malformed or non-Codex providers", () => {
    const root = mkdtempSync(join(tmpdir(), "worklog-ccswitch-empty-"));
    try {
      const db = new Database(join(root, "cc-switch.db"));
      db.run("CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, is_current INTEGER, meta TEXT, created_at INTEGER)");
      db.query("INSERT INTO providers VALUES (?,?,?,?,?,?,?)").run("bad", "claude", "Claude", "{}", 1, "{}", 1);
      db.close();
      expect(discoverCcswitchConfig(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
