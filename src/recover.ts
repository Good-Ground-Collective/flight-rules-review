import { JsonReviewCodec } from "@good-ground-collective/flight-rules/review";
import type { FindingRecord, ReviewState } from "@good-ground-collective/flight-rules/review";
import type { PullSnapshot } from "./pull-request.js";

export const SUMMARY_MARKER = "<!-- flight-rules-review:summary -->";

export type RecordLocation =
  | { kind: "review_comment"; comment_id: number }
  | { kind: "review_body"; review_id: number };

export interface LocatedRecord {
  record: FindingRecord;
  location: RecordLocation;
  url: string;
}
export type ActionableEntry = Exclude<ReviewState["records"][number], { status: "informational" }>;
export type InformationalEntry = Extract<ReviewState["records"][number], { status: "informational" }>;

export interface RecoveredState {
  summaryCommentId: number | null;
  state: ReviewState | undefined;
  records: LocatedRecord[];
  informational: InformationalEntry[];
  /** Indexed records whose marker could not be read; carried forward verbatim so no blocker is dropped. */
  unrecovered: ActionableEntry[];
  /** True when an earlier summary exists but its state could not be read; it must not be overwritten. */
  stateUnreadable: boolean;
  problems: string[];
  /** Reconciled differences from a partial earlier post; worth reporting, not blocking. */
  notes: string[];
}

function sameLocation(a: RecordLocation, b: RecordLocation): boolean {
  return a.kind === "review_comment" && b.kind === "review_comment"
    ? a.comment_id === b.comment_id
    : a.kind === "review_body" && b.kind === "review_body" && a.review_id === b.review_id;
}

/**
 * Rebuilds the portable state (contract §6.1) from GitHub: the summary index plus every finding marker
 * authored by a trusted reviewer identity. Markers anywhere else are ignored, and unrecoverable index
 * entries are reported so the pass ends INCOMPLETE instead of dropping a blocker.
 */
export function recoverState(snapshot: PullSnapshot, trustedIds: number[]): RecoveredState {
  const codec = new JsonReviewCodec();
  const problems: string[] = [];
  const notes: string[] = [];
  const trusted = (id: number | undefined): id is number => id !== undefined && trustedIds.includes(id);

  const summaries = snapshot.issueComments.filter(
    (comment) => trusted(comment.user?.id) && (comment.body ?? "").includes(SUMMARY_MARKER),
  );
  // Every trusted summary is parsed: an unreadable one may hold the only index of earlier records, so it
  // keeps every pass INCOMPLETE (and is never overwritten) until a human repairs or deletes it.
  let stateUnreadable = false;
  const readable: { id: number; updated: string; state: ReviewState }[] = [];
  for (const comment of summaries) {
    try {
      const parsed = codec.readState({ body: comment.body ?? "", authorId: comment.user!.id, trustedAuthorIds: trustedIds });
      if (parsed === undefined) throw new Error("it has no state marker");
      readable.push({ id: comment.id, updated: comment.updated_at, state: parsed });
    } catch (error) {
      stateUnreadable = true;
      problems.push(`summary comment ${comment.html_url} has unreadable state (${(error as Error).message}); repair or delete it`);
    }
  }
  if (readable.length > 1) notes.push(`found ${readable.length} readable summary comments; using the most recently updated`);
  const summary = readable.sort((a, b) => b.updated.localeCompare(a.updated))[0];
  const state = summary?.state;

  const found: LocatedRecord[] = [];
  const read = (body: string, authorId: number, location: RecordLocation, url: string): void => {
    try {
      for (const record of codec.readFindings({ body, authorId, trustedAuthorIds: trustedIds }))
        found.push({ record, location, url });
    } catch (error) {
      problems.push(`unreadable finding marker at ${url}: ${(error as Error).message}`);
    }
  };
  for (const comment of snapshot.reviewComments)
    if (trusted(comment.user?.id) && comment.in_reply_to_id === undefined)
      read(comment.body ?? "", comment.user!.id, { kind: "review_comment", comment_id: comment.id }, comment.html_url);
  for (const review of snapshot.reviews)
    if (trusted(review.user?.id) && review.body)
      read(review.body, review.user!.id, { kind: "review_body", review_id: review.id }, review.html_url);

  const byId = new Map<string, LocatedRecord[]>();
  for (const entry of found) byId.set(entry.record.finding.id, [...(byId.get(entry.record.finding.id) ?? []), entry]);

  const records: LocatedRecord[] = [];
  const unrecovered: ActionableEntry[] = [];
  const indexed = new Set<string>();
  for (const entry of state?.records ?? []) {
    if (entry.status === "informational") continue;
    indexed.add(entry.id);
    const located = (byId.get(entry.id) ?? []).find((candidate) => sameLocation(candidate.location, entry.location));
    if (located === undefined) {
      problems.push(`finding ${entry.id} (${entry.status}) is indexed but its marker is missing`);
      unrecovered.push(entry);
      continue;
    }
    if (located.record.status !== entry.status)
      notes.push(`finding ${entry.id} is ${located.record.status} in its marker but ${entry.status} in the index`);
    records.push(located);
  }
  for (const [id, entries] of byId) {
    if (indexed.has(id)) continue;
    if (entries.length > 1) problems.push(`orphan finding ${id} appears in ${entries.length} places`);
    notes.push(`recovered unindexed finding ${id} from a partial post`);
    records.push(entries[0]!);
  }

  const informational = (state?.records ?? []).filter(
    (entry): entry is InformationalEntry => entry.status === "informational",
  );
  return { summaryCommentId: summary?.id ?? null, state, records, informational, unrecovered, stateUnreadable, problems, notes };
}
