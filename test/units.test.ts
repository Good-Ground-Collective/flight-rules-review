import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checksFile, checksGreen, GitHubHeadChecks, ownRun, type CheckRun, type HeadChecks } from "../src/checks.js";
import { commentableLines, hunkIndex, place } from "../src/diff.js";
import { readStructuredOutput } from "../src/execution.js";
import { gateExitCode } from "../src/gate.js";
import { GitHubClient, GitHubError } from "../src/github.js";
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

describe("head checks", () => {
  /** A GitHub REST check-run payload. */
  const wireRun = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    name: "ci",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/o/r/runs/1",
    details_url: "https://github.com/o/r/actions/runs/11/job/1",
    completed_at: "2026-01-01T00:00:00Z",
    app: { slug: "github-actions", id: 15368 },
    head_sha: "abc",
    ...overrides,
  });
  const run = (overrides: Partial<CheckRun> = {}): CheckRun => ({
    id: 1,
    name: "ci",
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://github.com/o/r/runs/1",
    detailsUrl: "https://github.com/o/r/actions/runs/11/job/1",
    completedAt: "2026-01-01T00:00:00Z",
    app: "github-actions",
    ...overrides,
  });
  const checks = (runs: CheckRun[], state = "pending", totalCount = 0): HeadChecks => ({ runs, status: { state, totalCount, statuses: [] } });

  it("recognises this workflow run's own jobs only", () => {
    expect(ownRun(run(), "11")).toBe(true);
    expect(ownRun(run(), "1")).toBe(false);
    expect(ownRun(run(), "")).toBe(false);
    expect(ownRun(run({ detailsUrl: null }), "11")).toBe(false);
  });

  it("loads every page, maps the payload to camelCase and drops this run's jobs", async () => {
    const pages: Record<string, unknown> = {
      "1": { total_count: 101, check_runs: Array.from({ length: 100 }, (_, index) => wireRun({ id: index + 1 })) },
      "2": { total_count: 101, check_runs: [wireRun({ id: 500, name: "review", details_url: "https://github.com/o/r/actions/runs/99/job/7" })] },
    };
    const status = { state: "failure", total_count: 1, statuses: [{ context: "deploy", state: "failure", description: null, target_url: "https://ci/1" }] };
    const paths: string[] = [];
    const client = {
      get: async (path: string) => {
        paths.push(path);
        return path.includes("/status") ? status : pages[/&page=(\d+)/.exec(path)![1]!];
      },
    } as unknown as GitHubClient;
    const loaded = await new GitHubHeadChecks({ client, repo: "o/r", runId: "99" }).load("abc");
    expect(loaded.runs).toHaveLength(100);
    expect(loaded.runs[0]).toEqual(run());
    expect(loaded.status).toEqual({ state: "failure", totalCount: 1, statuses: [{ context: "deploy", state: "failure", description: null, targetUrl: "https://ci/1" }] });
    expect(paths).toEqual([
      "/repos/o/r/commits/abc/check-runs?per_page=100&page=1",
      "/repos/o/r/commits/abc/check-runs?per_page=100&page=2",
      "/repos/o/r/commits/abc/status?per_page=100",
    ]);
  });

  it("is green only when every run and status has passed", () => {
    expect(checksGreen(checks([run(), run({ conclusion: "skipped" })]))).toEqual({ green: true, reason: "" });
    expect(checksGreen(checks([run({ name: "test", status: "in_progress", conclusion: null })]))).toEqual({ green: false, reason: "test still running" });
    expect(checksGreen(checks([run({ name: "lint", conclusion: "failure" })]))).toEqual({ green: false, reason: "lint did not pass" });
    expect(checksGreen(checks([run()], "failure", 1))).toEqual({ green: false, reason: "commit status is failure" });
  });

  it("writes checks.json with citable snake_case ids, outcomes and the pending count", () => {
    const file = checksFile(checks([run(), run({ id: 2, name: "test", status: "queued", conclusion: null, htmlUrl: null })]), "abc", "now");
    expect(file).toMatchObject({
      head_sha: "abc",
      fetched_at: "now",
      available: true,
      pending: 1,
      check_runs: [
        { check_run_id: 1, name: "ci", app: "github-actions", status: "completed", conclusion: "success", url: "https://github.com/o/r/runs/1", completed_at: "2026-01-01T00:00:00Z" },
        { check_run_id: 2, name: "test", status: "queued", conclusion: null, url: "https://github.com/o/r/actions/runs/11/job/1" },
      ],
      commit_status: { state: "none", statuses: [] },
    });
  });

  it("marks CI unavailable instead of failing when it could not be read", () => {
    const file = checksFile(new Error("403 Resource not accessible by integration"), "abc", "now");
    expect(file).toMatchObject({ available: false, check_runs: [], commit_status: { state: "unknown" } });
    expect(file.note).toMatch(/could not be fetched \(403 Resource not accessible by integration\)/);
  });
});

describe("GitHubClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const client = () => new GitHubClient({ token: "t", apiUrl: "https://api.test", graphqlUrl: "https://api.test/graphql" });

  it("sends a POST that failed with a 5xx only once, since it may have been applied", async () => {
    const fetch = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    vi.stubGlobal("fetch", fetch);
    await expect(client().write("POST", "/repos/o/r/pulls/7/reviews", { body: "x" })).rejects.toBeInstanceOf(GitHubError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a GET that failed with a 5xx", "GET", 502],
    ["a POST that was rate limited", "POST", 429],
  ] as const)("retries %s", async (_case, method, status) => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const pending = method === "GET" ? client().get("/repos/o/r") : client().write("POST", "/repos/o/r/issues/7/comments", { body: "x" });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
