import { JsonReviewCodec } from "@good-ground-collective/flight-rules/review";
import type { FindingRecord, PriorFinding, ReviewOutcome } from "@good-ground-collective/flight-rules/review";
import { hunkIndex, place, type Placement } from "./diff.js";
import { GitHubError, type GitHubClient } from "./github.js";
import type { PullSnapshot, Review, ReviewComment } from "./pull-request.js";
import type { LocatedRecord, RecordLocation } from "./recover.js";
import type { PublishedRecord, Transition } from "./summary.js";

export const BODY_BUDGET = 60_000;
const BLOCKING: ReviewOutcome[] = ["CHANGES_NEEDED", "ESCALATE"];

export interface PublishInput {
  client: GitHubClient;
  repo: string;
  snapshot: PullSnapshot;
  headSha: string;
  botId: number;
  /** Records recovered from GitHub before this pass. */
  recovered: LocatedRecord[];
  /** Every record the evidence-checked plan retains, including new ones. */
  planned: FindingRecord[];
  priorEntries: PriorFinding[];
  outcome: ReviewOutcome;
  requestChanges: boolean;
  summaryUrl: string;
  log: (line: string) => void;
}
export interface PublishResult {
  records: PublishedRecord[];
  transitions: Transition[];
  problems: string[];
  /** Thread resolutions to apply only after the summary/state is persisted. */
  resolutions: string[];
}

const codec = new JsonReviewCodec();

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Splits rendered findings into review bodies under GitHub's size limit. */
export function chunkBodies(header: string, rendered: string[]): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = header.length;
  for (const block of rendered) {
    if (current.length > 0 && size + block.length + 7 > BODY_BUDGET) {
      chunks.push([header, ...current].join("\n\n---\n\n"));
      current = [];
      size = header.length;
    }
    current.push(block);
    size += block.length + 7;
  }
  if (current.length > 0) chunks.push([header, ...current].join("\n\n---\n\n"));
  return chunks;
}

/** The app's effective review state: GitHub counts a reviewer's latest non-COMMENTED review. */
export function activeChangesRequested(reviews: Review[], botId: number): Review[] {
  const mine = reviews.filter((review) => review.user?.id === botId && review.state !== "COMMENTED" && review.state !== "PENDING");
  const latest = mine.at(-1);
  return latest?.state === "CHANGES_REQUESTED" ? mine.filter((review) => review.state === "CHANGES_REQUESTED") : [];
}

function transitionReply(prior: FindingRecord, next: FindingRecord, entry: PriorFinding | undefined, headSha: string): string | null {
  const reason = entry?.reason ?? "";
  if (prior.status === "open" && next.status === "resolved") return `**Resolved** at \`${shortSha(headSha)}\`: ${reason}`;
  if (prior.status === "open" && next.status === "withdrawn")
    return `**Withdrawn** (${entry?.status === "withdrawn" ? entry.withdrawal_basis.replaceAll("_", " ") : "withdrawn"}): ${reason}`;
  if (JSON.stringify(prior.finding) !== JSON.stringify(next.finding) || JSON.stringify(prior.decision) !== JSON.stringify(next.decision)) {
    // The replacement overwrites the root marker, so the full preceding record lives on in this reply.
    const previous = codec.render(prior).replace("<!-- code-review:finding ", "<!-- flight-rules-review:previous ");
    return `**Updated** at \`${shortSha(headSha)}\`: ${reason}\n\n<details>\n<summary>Previous version</summary>\n\n${previous}\n\n</details>`;
  }
  if (entry?.status === "still_open" && entry.reply) return entry.reply;
  return null;
}

/** The finding ID a comment's marker carries, or undefined when it has none or is unreadable. */
function markerId(body: string | null): string | undefined {
  try {
    return codec.parseFinding(body ?? "")?.finding.id;
  } catch {
    return undefined;
  }
}

/** Root comments the app wrote, by the finding ID their marker carries; each marker is parsed once. */
export function markerRoots(snapshot: PullSnapshot, botId: number): Map<string, number[]> {
  const roots = new Map<string, number[]>();
  for (const comment of snapshot.reviewComments) {
    if (comment.user?.id !== botId || comment.in_reply_to_id !== undefined) continue;
    const id = markerId(comment.body);
    if (id !== undefined) roots.set(id, [...(roots.get(id) ?? []), comment.id]);
  }
  return roots;
}

/**
 * Threads to resolve for a closed finding: the thread at its indexed location plus every other unresolved
 * thread whose root is a marker the app wrote for the same finding ID (a duplicate from an earlier post).
 */
export function threadsFor(
  threads: PullSnapshot["threads"],
  roots: Map<string, number[]>,
  findingId: string,
  location: RecordLocation,
): string[] {
  const ids = new Set(roots.get(findingId) ?? []);
  if (location.kind === "review_comment") ids.add(location.comment_id);
  return threads.filter((thread) => !thread.isResolved && thread.rootCommentId !== null && ids.has(thread.rootCommentId)).map((thread) => thread.id);
}

function inlineComment(placement: Extract<Placement, { kind: "inline" }>, body: string): Record<string, unknown> {
  return {
    path: placement.path,
    line: placement.line,
    side: "RIGHT",
    ...(placement.startLine !== undefined ? { start_line: placement.startLine, start_side: "RIGHT" } : {}),
    body,
  };
}

/**
 * Persists one pass in contract order: new finding artifacts, then in-place record updates and replies.
 * The caller writes the summary/state next, then applies thread resolutions and the final gate review.
 * A blocking outcome makes the findings review a REQUEST_CHANGES review when enabled.
 */
export async function publish(input: PublishInput): Promise<PublishResult> {
  const { client, repo, snapshot, headSha } = input;
  const number = snapshot.pull.number;
  const problems: string[] = [];
  const resolutions: string[] = [];
  const transitions: Transition[] = [];
  const recoveredById = new Map(input.recovered.map((entry) => [entry.record.finding.id, entry]));
  const entries = new Map(input.priorEntries.map((entry) => [entry.id, entry]));
  const published: PublishedRecord[] = [];

  // 1. Updates to existing records. A record is indexed in its new form only once its marker write
  // succeeded; on failure the last confirmed record stays in the index (contract §5.2).
  type Update = { prior: LocatedRecord; next: FindingRecord; changed: boolean; reply: string | null; reason: string };
  const accept = (update: Update): void => {
    published.push({ record: update.next, location: update.prior.location, url: update.prior.url });
    if (update.changed)
      transitions.push({
        id: update.next.finding.id,
        from: update.prior.record.status,
        to: update.next.status,
        updated: JSON.stringify(update.prior.record.finding) !== JSON.stringify(update.next.finding),
        reason: update.reason,
      });
  };
  const keep = (update: Update): void => {
    published.push({ record: update.prior.record, location: update.prior.location, url: update.prior.url });
  };
  const reply = async (update: Update): Promise<void> => {
    if (update.reply === null) return;
    const location = update.prior.location;
    try {
      if (location.kind === "review_comment")
        await client.write("POST", `/repos/${repo}/pulls/${number}/comments/${location.comment_id}/replies`, { body: update.reply });
      else
        await client.write("POST", `/repos/${repo}/issues/${number}/comments`, {
          body: `**${update.next.finding.id}** (${update.next.finding.subject})\n\n${update.reply}`,
        });
    } catch (error) {
      problems.push(`could not post the reply for ${update.next.finding.id}: ${(error as Error).message}`);
    }
  };

  const bodyGroups = new Map<number, Update[]>();
  for (const next of input.planned) {
    const prior = recoveredById.get(next.finding.id);
    if (prior === undefined) continue;
    const entry = entries.get(next.finding.id);
    const update: Update = {
      prior,
      next,
      changed: JSON.stringify(prior.record) !== JSON.stringify(next),
      reply: transitionReply(prior.record, next, entry, headSha),
      reason: entry?.reason ?? "",
    };
    if (prior.location.kind === "review_body") {
      bodyGroups.set(prior.location.review_id, [...(bodyGroups.get(prior.location.review_id) ?? []), update]);
      continue;
    }
    if (update.changed) {
      try {
        await client.write("PATCH", `/repos/${repo}/pulls/comments/${prior.location.comment_id}`, { body: codec.render(next) });
      } catch (error) {
        problems.push(`could not persist the update to ${next.finding.id}: ${(error as Error).message}`);
        keep(update);
        continue;
      }
    }
    accept(update);
    await reply(update);
  }
  for (const [reviewId, updates] of bodyGroups) {
    if (!updates.some((update) => update.changed)) {
      for (const update of updates) {
        accept(update);
        await reply(update);
      }
      continue;
    }
    const original = snapshot.reviews.find((review) => review.id === reviewId);
    const header = (original?.body ?? "").split("\n\n---\n\n")[0] ?? "";
    try {
      await client.write("PUT", `/repos/${repo}/pulls/${number}/reviews/${reviewId}`, {
        body: [header, ...updates.map((update) => codec.render(update.next))].join("\n\n---\n\n"),
      });
      for (const update of updates) {
        accept(update);
        await reply(update);
      }
    } catch (error) {
      problems.push(`could not update the findings in review ${reviewId}: ${(error as Error).message}`);
      for (const update of updates) keep(update);
    }
  }

  // 2. New records: place each one, post file-level comments, then one review holding the rest.
  const files = hunkIndex(snapshot.files);
  const fresh = input.planned.filter((record) => !recoveredById.has(record.finding.id));
  const inline: { record: FindingRecord; placement: Extract<Placement, { kind: "inline" }> }[] = [];
  const fileLevel: { record: FindingRecord; path: string }[] = [];
  const body: FindingRecord[] = [];
  for (const record of fresh) {
    const placement = place(record.finding, files);
    if (placement.kind === "inline") inline.push({ record, placement });
    else if (placement.kind === "file") fileLevel.push({ record, path: placement.path });
    else body.push(record);
  }

  const knownReviews = new Set(snapshot.reviews.map((review) => review.id));
  const knownComments = new Set(snapshot.reviewComments.map((comment) => comment.id));
  /**
   * GitHub can answer a write with an error (a 422 "An internal error occurred, please try again", or a
   * 5xx) after it created the review or comment, and reposting would publish the finding twice. Finds such
   * an artifact; `null` means the lookup itself failed, so nothing may be reposted.
   */
  const findCreated = async <T>(what: string, path: string, match: (item: T) => boolean): Promise<T | undefined | null> => {
    if (client.dryRun) return undefined;
    try {
      return (await client.paginate<T>(path)).find(match);
    } catch (error) {
      input.log(`could not check whether the failed ${what} was created: ${(error as Error).message}`);
      return null;
    }
  };
  const findCreatedReview = (body: string) =>
    findCreated<Review>("review", `/repos/${repo}/pulls/${number}/reviews`, (review) =>
      !knownReviews.has(review.id) && review.user?.id === input.botId && review.commit_id === headSha && (review.body ?? "").trim() === body.trim(),
    );
  const findCreatedComment = (record: FindingRecord) =>
    findCreated<ReviewComment>("comment", `/repos/${repo}/pulls/${number}/comments`, (comment) =>
      !knownComments.has(comment.id) &&
      comment.user?.id === input.botId &&
      comment.in_reply_to_id === undefined &&
      markerId(comment.body) === record.finding.id,
    );

  /** `unknown`: the post failed and whether it landed could not be checked, so it must not be reposted. */
  const postFileLevel = async (record: FindingRecord, path: string): Promise<"posted" | "failed" | "unknown"> => {
    let comment: ReviewComment | undefined;
    try {
      comment = await client.write<ReviewComment>("POST", `/repos/${repo}/pulls/${number}/comments`, {
        body: codec.render(record),
        commit_id: headSha,
        path,
        subject_type: "file",
      });
    } catch (error) {
      const found = await findCreatedComment(record);
      if (found === null) return "unknown";
      if (found === undefined) {
        input.log(`file-level comment for ${record.finding.id} failed, moving it to the review body: ${(error as Error).message}`);
        return "failed";
      }
      input.log(`file-level comment for ${record.finding.id} reported an error but was created: ${(error as Error).message}`);
      comment = found;
    }
    knownComments.add(comment.id);
    published.push({ record, location: { kind: "review_comment", comment_id: comment.id }, url: comment.html_url });
    return "posted";
  };
  for (const { record, path } of fileLevel) if ((await postFileLevel(record, path)) === "failed") body.push(record);

  const blocking = BLOCKING.includes(input.outcome);
  const event = blocking && input.requestChanges ? "REQUEST_CHANGES" : "COMMENT";
  const needsGateReview = blocking && input.requestChanges && activeChangesRequested(snapshot.reviews, input.botId).length === 0;
  if (inline.length > 0 || body.length > 0 || needsGateReview) {
    const header = [
      `**flight-rules review** of \`${shortSha(headSha)}\`: ${fresh.length} new finding${fresh.length === 1 ? "" : "s"}.`,
      blocking
        ? `This PR has open blocking findings; see the [summary](${input.summaryUrl}) for everything that remains.`
        : `See the [summary](${input.summaryUrl}).`,
    ].join(" ");
    const index = (record: FindingRecord, location: RecordLocation, url: string): void => {
      if (!published.some((entry) => entry.record.finding.id === record.finding.id)) published.push({ record, location, url });
    };
    /** Posts chunks in order and stops at the first failure, so nothing already posted is replayed. */
    const postChunks = async (
      comments: typeof inline,
      bodyRecords: FindingRecord[],
    ): Promise<{ failed: number; error?: unknown; unknown?: boolean }> => {
      const chunks = chunkBodies(header, bodyRecords.map((record) => codec.render(record)));
      if (chunks.length === 0) chunks.push(header);
      for (const [position, chunk] of chunks.entries()) {
        let review: Review;
        try {
          review = await client.write<Review>("POST", `/repos/${repo}/pulls/${number}/reviews`, {
            commit_id: headSha,
            event: position === chunks.length - 1 ? event : "COMMENT",
            body: chunk,
            comments: position === 0 ? comments.map(({ record, placement }) => inlineComment(placement, codec.render(record))) : [],
          });
        } catch (error) {
          const found = await findCreatedReview(chunk);
          if (found === null || found === undefined) return { failed: position, error, unknown: found === null };
          input.log(`review ${found.id} was created although GitHub reported an error: ${(error as Error).message}`);
          review = found;
        }
        knownReviews.add(review.id);
        for (const record of bodyRecords)
          if (chunk.includes(`"id":"${record.finding.id}"`)) index(record, { kind: "review_body", review_id: review.id }, review.html_url);
        if (position === 0 && comments.length > 0) {
          const posted = client.dryRun
            ? comments.map(({ record }, offset) => ({ id: review.id + offset + 1, body: codec.render(record), html_url: review.html_url }))
            : await client.paginate<ReviewComment>(`/repos/${repo}/pulls/${number}/reviews/${review.id}/comments`);
          for (const comment of posted) {
            const record = codec.parseFinding(comment.body ?? "");
            const match = record && comments.find((candidate) => candidate.record.finding.id === record.finding.id);
            if (match) index(match.record, { kind: "review_comment", comment_id: comment.id }, comment.html_url);
          }
        }
      }
      return { failed: -1 };
    };

    let attempt = await postChunks(inline, body);
    // Only a rejected first chunk (nothing posted, confirmed by a lookup) is retried, with inline findings demoted.
    if (
      attempt.failed === 0 &&
      attempt.unknown !== true &&
      inline.length > 0 &&
      attempt.error instanceof GitHubError &&
      attempt.error.status === 422
    ) {
      input.log(`inline review rejected (${attempt.error.detail}); retrying with file-level placement`);
      const demoted: FindingRecord[] = [...body];
      for (const { record, placement } of inline) if ((await postFileLevel(record, placement.path)) === "failed") demoted.push(record);
      attempt = await postChunks([], demoted);
    }
    if (attempt.failed >= 0) problems.push(`could not submit the findings review: ${(attempt.error as Error).message}`);
  }

  const roots = markerRoots(snapshot, input.botId);
  for (const entry of published) {
    if (entry.record.status === "open") continue;
    for (const thread of threadsFor(snapshot.threads, roots, entry.record.finding.id, entry.location))
      if (!resolutions.includes(thread)) resolutions.push(thread);
  }

  const missing = fresh.filter(
    (record) => !published.some((entry) => entry.record.finding.id === record.finding.id),
  );
  for (const record of missing) problems.push(`new finding ${record.finding.id} was not published`);
  return { records: published, transitions, problems, resolutions };
}

export async function resolveThreads(client: GitHubClient, threadIds: string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const threadId of threadIds) {
    try {
      await client.writeGraphql(
        "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}",
        { id: threadId },
      );
    } catch (error) {
      problems.push(`could not resolve thread ${threadId}: ${(error as Error).message}`);
    }
  }
  return problems;
}

export function locationKey(location: RecordLocation): string {
  return location.kind === "review_comment" ? `c${location.comment_id}` : `r${location.review_id}`;
}
