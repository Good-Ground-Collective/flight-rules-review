import { JsonReviewCodec } from "@good-ground-collective/flight-rules/review";
import { describe, expect, it } from "vitest";
import { GitHubError, type GitHubClient } from "../src/github.js";
import { activeChangesRequested, chunkBodies, publish } from "../src/publish.js";
import { recoverState, SUMMARY_MARKER } from "../src/recover.js";
import { renderSummary, stateIndex, SUMMARY_BUDGET } from "../src/summary.js";
import { AUTHOR, BOT, FakeClient, findingComment, HEAD, record, snapshot } from "./fixtures.js";

const codec = new JsonReviewCodec();

function summaryComment(body: string, user = BOT) {
  return { id: 77, body, user, html_url: "https://github.com/o/r/pull/7#issuecomment-77", created_at: "x", updated_at: "x" };
}

describe("recoverState", () => {
  it("recovers indexed records only from trusted authors", () => {
    const rec = record();
    const index = codec.state(stateIndex({ headSha: HEAD, outcome: "CHANGES_NEEDED", records: [{ record: rec, location: { kind: "review_comment", comment_id: 1 }, url: "u" }], informational: [] }));
    const recovered = recoverState(
      snapshot({
        issueComments: [summaryComment(`${SUMMARY_MARKER}\n${index}`), summaryComment(`${SUMMARY_MARKER}\n${index}`, AUTHOR)],
        reviewComments: [findingComment(1, rec), findingComment(2, record({ id: "f-aaaaaaaaaa" }), AUTHOR)],
      }),
      [BOT.id],
    );
    expect(recovered.problems).toEqual([]);
    expect(recovered.summaryCommentId).toBe(77);
    expect(recovered.records.map((entry) => entry.record.finding.id)).toEqual(["f-0123456789"]);
  });

  it("reports an indexed record whose marker is gone and recovers orphans", () => {
    const index = codec.state(stateIndex({ headSha: HEAD, outcome: "CHANGES_NEEDED", records: [{ record: record(), location: { kind: "review_comment", comment_id: 1 }, url: "u" }], informational: [] }));
    const orphan = record({ id: "f-bbbbbbbbbb" });
    const recovered = recoverState(
      snapshot({ issueComments: [summaryComment(`${SUMMARY_MARKER}\n${index}`)], reviewComments: [findingComment(3, orphan)] }),
      [BOT.id],
    );
    expect(recovered.problems).toEqual(["finding f-0123456789 (open) is indexed but its marker is missing"]);
    expect(recovered.records.map((entry) => entry.record.finding.id)).toEqual(["f-bbbbbbbbbb"]);
    expect(recovered.notes[0]).toMatch(/unindexed finding f-bbbbbbbbbb/);
  });
});

describe("recovery never drops a blocker", () => {
  it("carries an unrecoverable index entry into the next state", () => {
    const lost = { id: "f-0123456789", status: "open" as const, location: { kind: "review_comment" as const, comment_id: 1 } };
    const index = codec.state({ v: 1, schema_revision: 1, sha: HEAD, outcome: "CHANGES_NEEDED", records: [lost] });
    const recovered = recoverState(snapshot({ issueComments: [summaryComment(`${SUMMARY_MARKER}\n${index}`)] }), [BOT.id]);
    expect(recovered.unrecovered).toEqual([lost]);
    const body = renderSummary({ outcome: "INCOMPLETE", headSha: HEAD, problems: recovered.problems, notes: [], records: [], informational: [], unrecovered: recovered.unrecovered, transitions: [] });
    expect(codec.readState({ body, authorId: 1, trustedAuthorIds: [1] })?.records).toEqual([lost]);
  });

  it("never selects or overwrites an unreadable summary, and keeps reporting it", () => {
    const good = codec.state({ v: 1, schema_revision: 1, sha: HEAD, outcome: "APPROVED", records: [] });
    const recovered = recoverState(
      snapshot({
        issueComments: [
          { ...summaryComment(`${SUMMARY_MARKER}\n<!-- code-review:state {broken -->`), id: 1, updated_at: "2026-02-01" },
          { ...summaryComment(`${SUMMARY_MARKER}\n${good}`), id: 2, updated_at: "2026-01-01" },
        ],
      }),
      [BOT.id],
    );
    expect(recovered.summaryCommentId).toBe(2);
    expect(recovered.stateUnreadable).toBe(true);
    expect(recovered.problems[0]).toMatch(/unreadable state/);
  });
});

describe("renderSummary", () => {
  it("leads with the outcome and ends with a parseable state marker", () => {
    const rec = record();
    const body = renderSummary({
      outcome: "CHANGES_NEEDED",
      headSha: HEAD,
      outcomeReason: "One blocking fix.",
      problems: [],
      notes: [],
      records: [{ record: rec, location: { kind: "review_comment", comment_id: 1 }, url: "https://x" }],
      informational: [],
      transitions: [],
    });
    expect(body.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(body).toContain("> [!CAUTION]");
    expect(body).toContain("### Required fixes");
    const state = codec.readState({ body, authorId: 1, trustedAuthorIds: [1] });
    expect(state?.records).toEqual([{ id: rec.finding.id, status: "open", location: { kind: "review_comment", comment_id: 1 } }]);
  });

  it("names every problem when incomplete and stays under budget", () => {
    const records = Array.from({ length: 400 }, (_, index) => ({
      record: record({ id: `f-${index.toString(16).padStart(10, "0")}`, subject: "x".repeat(300), blocking: false, severity: "minor", label: "suggestion" }),
      location: { kind: "review_comment" as const, comment_id: index + 1 },
      url: "https://x",
    }));
    const body = renderSummary({ outcome: "INCOMPLETE", headSha: HEAD, problems: ["state write failed"], notes: [], records, informational: [], transitions: [] });
    expect(body).toContain("state write failed");
    expect(body.length).toBeLessThanOrEqual(SUMMARY_BUDGET);
  });
});

describe("chunkBodies and change-request state", () => {
  it("splits long bodies", () => {
    expect(chunkBodies("h", ["a".repeat(40_000), "b".repeat(40_000)])).toHaveLength(2);
    expect(chunkBodies("h", [])).toEqual([]);
  });

  it("treats only the latest non-comment review as the effective state", () => {
    const review = (id: number, state: string) => ({ id, state, user: BOT, body: "", html_url: "", commit_id: HEAD });
    expect(activeChangesRequested([review(1, "CHANGES_REQUESTED"), review(2, "COMMENTED")], BOT.id).map((r) => r.id)).toEqual([1]);
    expect(activeChangesRequested([review(1, "CHANGES_REQUESTED"), review(2, "DISMISSED")], BOT.id)).toEqual([]);
  });
});

describe("publish", () => {
  const base = (client: FakeClient, overrides = {}) => ({
    client: client as unknown as GitHubClient,
    repo: "o/r",
    snapshot: snapshot(),
    headSha: HEAD,
    botId: BOT.id,
    recovered: [],
    planned: [],
    priorEntries: [],
    outcome: "APPROVED" as const,
    requestChanges: true,
    summaryUrl: "https://s",
    log: () => {},
    ...overrides,
  });

  it("submits new blocking findings as a REQUEST_CHANGES review and indexes their comment ids", async () => {
    const client = new FakeClient();
    const inline = record();
    const body = record({ id: "f-cccccccccc", path: "", line: 0 });
    const result = await publish(base(client, { planned: [inline, body], outcome: "CHANGES_NEEDED" }));
    expect(result.problems).toEqual([]);
    const review = client.writes.find((write) => write.path.endsWith("/reviews"));
    expect(review?.body).toMatchObject({ event: "REQUEST_CHANGES", commit_id: HEAD });
    expect(result.records.map((entry) => entry.location.kind).sort()).toEqual(["review_body", "review_comment"]);
  });

  it("posts a gate review for a blocking outcome with no new findings and no active change request", async () => {
    const client = new FakeClient();
    await publish(base(client, { outcome: "ESCALATE" }));
    expect(client.writes).toHaveLength(1);
    expect(client.writes[0]?.body).toMatchObject({ event: "REQUEST_CHANGES" });
  });

  it("comments without requesting changes when disabled", async () => {
    const client = new FakeClient();
    await publish(base(client, { planned: [record()], outcome: "CHANGES_NEEDED", requestChanges: false }));
    expect(client.writes[0]?.body).toMatchObject({ event: "COMMENT" });
  });

  it("edits, replies to and queues resolution for a resolved inline finding", async () => {
    const client = new FakeClient();
    const prior = record();
    const resolved = { ...prior, status: "resolved" as const, evidence: [{ kind: "commit" as const, sha: HEAD }] };
    const result = await publish(
      base(client, {
        snapshot: snapshot({ threads: [{ id: "T1", isResolved: false, resolvedBy: null, rootCommentId: 1 }] }),
        recovered: [{ record: prior, location: { kind: "review_comment", comment_id: 1 }, url: "u" }],
        planned: [resolved],
        priorEntries: [{ id: prior.finding.id, status: "resolved", reason: "Fixed in abc.", evidence: resolved.evidence }],
      }),
    );
    expect(client.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
      "PATCH /repos/o/r/pulls/comments/1",
      "POST /repos/o/r/pulls/7/comments/1/replies",
    ]);
    expect((client.writes[1]?.body as { body: string }).body).toMatch(/^\*\*Resolved\*\* at `aaaaaaa`: Fixed in abc\./);
    expect(result.resolutions).toEqual(["T1"]);
    expect(result.transitions).toEqual([{ id: prior.finding.id, from: "open", to: "resolved", updated: false, reason: "Fixed in abc." }]);
  });

  it("keeps the confirmed record when the marker edit fails", async () => {
    const client = new FakeClient();
    client.failOn = (method, path) => (method === "PATCH" ? new GitHubError(500, method, path, "boom") : undefined);
    const prior = record();
    const resolved = { ...prior, status: "resolved" as const, evidence: [{ kind: "commit" as const, sha: HEAD }] };
    const result = await publish(
      base(client, {
        snapshot: snapshot({ threads: [{ id: "T1", isResolved: false, resolvedBy: null, rootCommentId: 1 }] }),
        recovered: [{ record: prior, location: { kind: "review_comment", comment_id: 1 }, url: "u" }],
        planned: [resolved],
        priorEntries: [{ id: prior.finding.id, status: "resolved", reason: "Fixed.", evidence: resolved.evidence }],
      }),
    );
    expect(result.records[0]?.record.status).toBe("open");
    expect(result.transitions).toEqual([]);
    expect(result.resolutions).toEqual([]);
    expect(result.problems[0]).toMatch(/could not persist the update/);
  });

  it("re-queues resolution for an already closed record whose thread is still open", async () => {
    const client = new FakeClient();
    const closed = { ...record(), status: "resolved" as const, evidence: [{ kind: "commit" as const, sha: HEAD }] };
    const result = await publish(
      base(client, {
        snapshot: snapshot({ threads: [{ id: "T9", isResolved: false, resolvedBy: null, rootCommentId: 1 }] }),
        recovered: [{ record: closed, location: { kind: "review_comment", comment_id: 1 }, url: "u" }],
        planned: [closed],
      }),
    );
    expect(client.writes).toEqual([]);
    expect(result.resolutions).toEqual(["T9"]);
  });

  it("does not replay posted chunks when a later chunk is rejected", async () => {
    const client = new FakeClient();
    let reviews = 0;
    client.failOn = (method, path) => {
      if (path.endsWith("/reviews") && ++reviews === 2) return new GitHubError(422, method, path, "rejected");
      return undefined;
    };
    const big = (n: number) => record({ id: `f-${String(n).padStart(10, "0")}`, path: "", line: 0, details: "d".repeat(15_000), discussion: "x".repeat(15_000) });
    const result = await publish(base(client, { planned: [record(), big(1), big(2)], outcome: "CHANGES_NEEDED" }));
    const ids = result.records.map((entry) => entry.record.finding.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(client.writes.filter((write) => write.path.endsWith("/reviews"))).toHaveLength(1);
    expect(result.problems.some((problem) => /could not submit the findings review/.test(problem))).toBe(true);
  });

  it("falls back to file-level comments when GitHub rejects the inline review", async () => {
    const client = new FakeClient();
    let rejected = false;
    client.failOn = (method, path, body) => {
      if (!rejected && path.endsWith("/reviews") && ((body as { comments: unknown[] }).comments ?? []).length > 0) {
        rejected = true;
        return new GitHubError(422, method, path, "line could not be resolved");
      }
      return undefined;
    };
    const result = await publish(base(client, { planned: [record()], outcome: "CHANGES_NEEDED" }));
    expect(result.problems).toEqual([]);
    expect(client.writes[0]?.body).toMatchObject({ subject_type: "file", path: "src/a.ts" });
    expect(result.records[0]?.location.kind).toBe("review_comment");
  });
});
