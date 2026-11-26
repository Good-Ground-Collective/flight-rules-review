import type { GitHubClient } from "./github.js";

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  details_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  app: { slug: string } | null;
}
export interface CommitStatus {
  context: string;
  state: string;
  description: string | null;
  target_url: string | null;
}
export interface HeadChecks {
  /** Check runs on the head, without this workflow run's own jobs. */
  runs: CheckRun[];
  /** Combined commit status; `total_count` 0 means no status contexts are reported. */
  status: { state: string; total_count: number; statuses: CommitStatus[] };
}

const PASSED = ["success", "neutral", "skipped"];

/** True for a check run that belongs to this workflow run (the review job itself or its siblings). */
export function ownRun(run: Pick<CheckRun, "details_url">, runId: string): boolean {
  return runId !== "" && (run.details_url?.includes(`/actions/runs/${runId}/`) ?? false);
}

/** Every check run and the combined commit status on `sha`, excluding this workflow run's jobs. */
export async function loadChecks(client: GitHubClient, repo: string, sha: string, runId: string): Promise<HeadChecks> {
  const runs: CheckRun[] = [];
  for (let page = 1; ; page++) {
    const { total_count: total, check_runs: batch } = await client.get<{ total_count: number; check_runs: CheckRun[] }>(
      `/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`,
    );
    runs.push(...batch);
    if (batch.length === 0 || runs.length >= total) break;
  }
  const status = await client.get<HeadChecks["status"]>(`/repos/${repo}/commits/${sha}/status?per_page=100`);
  return { runs: runs.filter((run) => !ownRun(run, runId)), status };
}

/** True when every check run and status context on the head has passed. */
export function checksGreen(checks: HeadChecks): { green: boolean; reason: string } {
  const pending = checks.runs.filter((run) => run.status !== "completed");
  if (pending.length > 0) return { green: false, reason: `${pending.map((run) => run.name).join(", ")} still running` };
  const failed = checks.runs.filter((run) => !PASSED.includes(run.conclusion ?? ""));
  if (failed.length > 0) return { green: false, reason: `${failed.map((run) => run.name).join(", ")} did not pass` };
  if (checks.status.total_count > 0 && checks.status.state !== "success")
    return { green: false, reason: `commit status is ${checks.status.state}` };
  return { green: true, reason: "" };
}

/** The reviewer's view of CI on the head: what ran, what passed, and what is still pending. */
export function checksContext(checks: HeadChecks, sha: string, fetchedAt: string): Record<string, unknown> {
  const pending = checks.runs.filter((run) => run.status !== "completed").length + checks.status.statuses.filter((s) => s.state === "pending").length;
  return {
    head_sha: sha,
    fetched_at: fetchedAt,
    note:
      "Snapshot taken before the review started; CI often runs alongside this review, so pending entries are normal. " +
      "Only a check run with status completed and conclusion success can be cited, as check_run evidence with its check_run_id. " +
      "This review's own jobs are excluded.",
    pending,
    check_runs: checks.runs.map((run) => ({
      check_run_id: run.id,
      name: run.name,
      app: run.app?.slug ?? null,
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url ?? run.details_url,
      completed_at: run.completed_at,
    })),
    commit_status: {
      state: checks.status.total_count > 0 ? checks.status.state : "none",
      statuses: checks.status.statuses.map((status) => ({
        context: status.context,
        state: status.state,
        description: status.description,
        url: status.target_url,
      })),
    },
  };
}
