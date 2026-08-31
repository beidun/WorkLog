import { describe, expect, test } from "bun:test";
import { loadDigestEvalSuite, runDigestEvalSuite } from "../src/digest-eval";

describe("digest evaluation", () => {
  test("keeps the built-in regression suite fully passing", async () => {
    const result = await runDigestEvalSuite(loadDigestEvalSuite());

    expect(result.caseCount).toBe(6);
    expect(result.passedCases).toBe(result.caseCount);
    expect(result.checkCount).toBe(29);
    expect(result.passedChecks).toBe(result.checkCount);
    expect(result.passRate).toBe(1);
  });

  test("reports the actual digest value when an expectation fails", async () => {
    const builtIn = loadDigestEvalSuite();
    const testCase = structuredClone(builtIn.cases[0]);
    testCase.expected.headline = "一个不会匹配的标题";

    const result = await runDigestEvalSuite({ version: builtIn.version, cases: [testCase] });
    const failure = result.checks.find((check) => !check.passed);

    expect(result.passedCases).toBe(0);
    expect(result.passedChecks).toBeLessThan(result.checkCount);
    expect(failure).toMatchObject({ caseId: testCase.id, check: "headline", passed: false });
    expect(failure?.detail).toContain("实际标题：核查龙虎榜接口有哪些");
  });
});
