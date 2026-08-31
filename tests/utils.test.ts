import { describe, expect, test } from "bun:test";
import { redactRawEvidence, redactSecrets, stripInjectedContext } from "../src/utils";

describe("history context filtering", () => {
  test("removes IDE and local command injections while preserving the user request", () => {
    const value = [
      "<ide_opened_file>unrelated file</ide_opened_file>",
      "<local-command-caveat>do not answer</local-command-caveat>",
      "请实现工作记录原型",
    ].join("\n");
    expect(stripInjectedContext(value)).toBe("请实现工作记录原型");
  });

  test("drops approval-review transcripts injected as user messages", () => {
    expect(stripInjectedContext("The following is the Codex agent history added since your last approval assessment. Continue review…"))
      .toBe("");
  });

  test("redacts curl credentials, cookies and authorization headers", () => {
    const value = "curl -u 'root:password' -b 'session=private' -H 'Authorization: Bearer private-token' https://user:pass@example.com";
    const redacted = redactSecrets(value);
    expect(redacted).not.toContain("password");
    expect(redacted).not.toContain("session=private");
    expect(redacted).not.toContain("private-token");
    expect(redacted).not.toContain("user:pass");
    expect(redacted).toContain("[REDACTED_BASIC_AUTH]");
  });

  test("removes encrypted payloads and secret JSON fields from raw evidence", () => {
    const raw = JSON.stringify({
      type: "reasoning",
      encrypted_content: "very-long-private-payload",
      metadata: { api_key: "private-key", useful: "kept" },
    });
    const redacted = redactRawEvidence(raw);
    expect(redacted).not.toContain("very-long-private-payload");
    expect(redacted).not.toContain("private-key");
    expect(redacted).toContain('"encrypted_content":"[REDACTED]"');
    expect(redacted).toContain('"useful":"kept"');
  });
});
