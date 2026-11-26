import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commentableLines, hunkIndex, place } from "../src/diff.js";
import { readStructuredOutput } from "../src/execution.js";
import { gateExitCode } from "../src/gate.js";
import { parseDecisionOwners } from "../src/inputs.js";
import { quotableJson, reviewerSchema, strictProblems } from "../src/strict.js";
import { PATCH, snapshot } from "./fixtures.js";

describe("diff placement", () => {
  it("collects right-side lines per hunk, skipping deletions", () => {
    expect(commentableLines("@@ -1,3 +1,2 @@\n a\n-b\n c\n@@ -10 +9,2 @@\n+x\n y").hunks).toEqual([[1, 2], [9, 10]]);
  });

  it("anchors inline inside a hunk, file-level outside it, body for unknown paths", () => {
    const files = hunkIndex(snapshot().files);
    expect(place({ path: "src/a.ts", line: 3 }, files)).toEqual({ kind: "inline", path: "src/a.ts", line: 3 });
    expect(place({ path: "src/a.ts", line: 3, start_line: 2 }, files)).toMatchObject({ startLine: 2 });
    expect(place({ path: "src/a.ts", line: 40 }, files)).toEqual({ kind: "file", path: "src/a.ts" });
    expect(place({ path: "src/b.ts", line: 1 }, files)).toEqual({ kind: "body" });
    expect(place({ path: "", line: 0 }, files)).toEqual({ kind: "body" });
  });

  it("puts findings on removed files in the body", () => {
    const files = hunkIndex([{ filename: "gone.ts", status: "removed", additions: 0, deletions: 3, patch: PATCH }]);
    expect(place({ path: "gone.ts", line: 1 }, files)).toEqual({ kind: "body" });
  });
});

describe("inputs", () => {
  it("parses owner maps and login lists", () => {
    expect(parseDecisionOwners("")).toEqual({});
    expect(parseDecisionOwners("@alice, bob")).toEqual({ "*": ["alice", "bob"] });
    expect(parseDecisionOwners('{"security owner":["carol"]}')).toEqual({ "security owner": ["carol"] });
    expect(() => parseDecisionOwners('{"x":[]}')).toThrow();
  });
});

describe("gate", () => {
  it("fails anything but APPROVED by default", () => {
    expect(gateExitCode("APPROVED", "not-approved")).toBe(0);
    for (const outcome of ["CHANGES_NEEDED", "ESCALATE", "INCOMPLETE"] as const) expect(gateExitCode(outcome, "not-approved")).toBe(1);
    expect(gateExitCode("CHANGES_NEEDED", "incomplete")).toBe(0);
    expect(gateExitCode("INCOMPLETE", "incomplete")).toBe(1);
    expect(gateExitCode("INCOMPLETE", "never")).toBe(0);
  });
});

describe("strict mode", () => {
  const coverage = {
    charterCoverage: {
      charters: ["coding-charter"],
      mandates: [
        { id: "M-1", charter: "coding-charter", state: "reviewed", files: ["src/a.ts"] },
        { id: "M-2", charter: "coding-charter", state: "not_applicable", files: [] },
      ],
    },
    lint: { status: "absent", detail: "No linter runs in strict mode." },
    counts: { tierA: 0, tierB: 0, holistic: 1 },
  };

  it("accepts full coverage", () => {
    expect(strictProblems({ review: { review_complete: true, extensions: { flight_rules: coverage } }, tierA: ["M-1", "M-2"], charters: ["coding-charter"] })).toEqual([]);
  });

  it("flags missing mandates, charters, enforced claims and incomplete passes", () => {
    expect(strictProblems({ review: { review_complete: true, extensions: { flight_rules: coverage } }, tierA: ["M-1", "M-3"], charters: ["coding-charter", "coding-charter-typescript"] })).toEqual([
      "charter coverage omits coding-charter-typescript",
      "Tier A coverage omits M-3",
    ]);
    const enforced = structuredClone(coverage);
    enforced.charterCoverage.mandates[0]!.state = "enforced";
    expect(strictProblems({ review: { review_complete: true, extensions: { flight_rules: enforced } }, tierA: [], charters: [] })[0]).toMatch(/extensions.flight_rules is missing or invalid/);
    expect(strictProblems({ review: { review_complete: false, incomplete_reason: "too big", extensions: { flight_rules: coverage } }, tierA: [], charters: [] })[0]).toMatch(/too big/);
  });

  it("builds a draft-07 reviewer schema that requires the extension and survives single quotes", () => {
    const schema = reviewerSchema(join(import.meta.dirname, "..", "dist"));
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect((schema.required as string[]).includes("extensions")).toBe(true);
    const text = quotableJson({ description: "it's" });
    expect(text).not.toContain("'");
    expect(JSON.parse(text)).toEqual({ description: "it's" });
  });
});

describe("execution transcript", () => {
  const file = (value: unknown): string => {
    const path = join(tmpdir(), `exec-${Math.random()}.json`);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };

  it("returns structured output from the final result", () => {
    expect(readStructuredOutput(file([{ type: "system" }, { type: "result", subtype: "success", structured_output: { a: 1 } }]))).toEqual({ ok: true, output: { a: 1 } });
  });

  it("reports missing, failed and empty runs", () => {
    expect(readStructuredOutput("").ok).toBe(false);
    expect(readStructuredOutput(file([{ type: "result", subtype: "error_max_turns" }]))).toEqual({ ok: false, reason: "the reviewer ended with error_max_turns" });
    expect(readStructuredOutput(file([{ type: "result", subtype: "success" }]))).toEqual({ ok: false, reason: "the reviewer returned no structured review" });
  });
});
