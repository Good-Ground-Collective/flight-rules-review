import { JsonReviewCodec } from "@good-ground-collective/flight-rules/review";
import type { FindingRecord } from "@good-ground-collective/flight-rules/review";
import { GitHubError } from "../src/github.js";
import type { PullSnapshot } from "../src/pull-request.js";

export const HEAD = "a".repeat(40);
export const BOT = { id: 900, login: "flight-rules-review[bot]", type: "Bot" };
export const AUTHOR = { id: 10, login: "author", type: "User" };

export function record(overrides: Partial<FindingRecord["finding"]> = {}, status: FindingRecord["status"] = "open"): FindingRecord {
  return {
    v: 1,
    schema_revision: 1,
    status,
    evidence: [],
    finding: {
      id: "f-0123456789",
      path: "src/a.ts",
      line: 3,
      label: "issue",
      type: "fix",
      blocking: true,
      severity: "major",
      subject: "Validate the input before use",
      discussion: "Unvalidated input reaches the query.",
      details: "Parse the input with the schema in src/a.ts:3 and add a test.",
      resolved_when: "The input is parsed and the test passes.",
      ...overrides,
    } as FindingRecord["finding"],
  };
}

export const PATCH = "@@ -1,2 +1,4 @@\n line1\n+line2\n+line3\n line4";

export function snapshot(partial: Partial<PullSnapshot> = {}): PullSnapshot {
  return {
    pull: {
      number: 7,
      title: "t",
      body: null,
      state: "open",
      draft: false,
      user: AUTHOR,
      head: { sha: HEAD, ref: "feature", repo: { full_name: "o/r" } },
      base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "o/r", default_branch: "main" } },
      labels: [],
      html_url: "https://github.com/o/r/pull/7",
      additions: 2,
      deletions: 0,
      changed_files: 1,
    },
    files: [{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 0, patch: PATCH }],
    issueComments: [],
    reviewComments: [],
    reviews: [],
    threads: [],
    ...partial,
  };
}

export function findingComment(id: number, rec: FindingRecord, user = BOT) {
  return {
    id,
    body: new JsonReviewCodec().render(rec),
    user,
    html_url: `https://github.com/o/r/pull/7#discussion_r${id}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    path: rec.finding.path,
    line: rec.finding.line,
    pull_request_review_id: 1,
  };
}

/** Records every write and answers with incrementing ids. */
export class FakeClient {
  writes: { method: string; path: string; body: unknown }[] = [];
  graphqlWrites: Record<string, unknown>[] = [];
  private next = 5000;
  dryRun = false;
  failOn?: (method: string, path: string, body: unknown) => Error | undefined;
  /** Like failOn, but the write takes effect before the error is thrown, as GitHub sometimes does. */
  landThenFail?: (method: string, path: string, body: unknown) => Error | undefined;
  /** Makes listing the PR's reviews and comments fail. */
  listingFails = false;
  reviewComments: Record<number, { id: number; body: string; html_url: string }[]> = {};
  /** Reviews and root review comments created through `write`, as the PR listings return them. */
  reviews: { id: number; body: string; user: typeof BOT; commit_id: string; state: string; html_url: string }[] = [];
  comments: { id: number; body: string; user: typeof BOT; html_url: string }[] = [];

  async get(): Promise<never> {
    throw new Error("unexpected get");
  }
  async paginate<T>(path: string): Promise<T[]> {
    if (/\/pulls\/\d+\/(reviews|comments)$/.test(path)) {
      if (this.listingFails) throw new GitHubError(502, "GET", path, "bad gateway");
      return (path.endsWith("/reviews") ? this.reviews : this.comments) as T[];
    }
    const id = Number(/reviews\/(\d+)\/comments/.exec(path)?.[1]);
    return (this.reviewComments[id] ?? []) as T[];
  }
  async write<T>(method: string, path: string, body?: unknown): Promise<T> {
    const failure = this.failOn?.(method, path, body);
    if (failure) throw failure;
    this.writes.push({ method, path, body });
    const id = this.next++;
    const html_url = `https://github.com/o/r/pull/7#x${id}`;
    if (method === "POST" && path.endsWith("/reviews")) {
      const posted = body as { body: string; commit_id: string; event: string; comments?: { body: string }[] };
      const comments = (posted.comments ?? []).map((comment, offset) => ({
        id: id * 10 + offset,
        body: comment.body,
        user: BOT,
        html_url: `https://github.com/o/r/pull/7#discussion_r${id * 10 + offset}`,
      }));
      this.reviewComments[id] = comments;
      this.comments.push(...comments);
      this.reviews.push({ id, body: posted.body, user: BOT, commit_id: posted.commit_id, state: posted.event, html_url });
    } else if (method === "POST" && /\/pulls\/\d+\/comments$/.test(path)) {
      this.comments.push({ id, body: (body as { body: string }).body, user: BOT, html_url });
    }
    const late = this.landThenFail?.(method, path, body);
    if (late) throw late;
    return { id, html_url } as T;
  }
  async writeGraphql(_query: string, variables: Record<string, unknown>): Promise<undefined> {
    this.graphqlWrites.push(variables);
    return undefined;
  }
}
