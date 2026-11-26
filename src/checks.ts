import { z } from "zod";
import type { GitHubClient } from "./github.js";

const CheckRunWireSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    html_url: z.string().nullable(),
    details_url: z.string().nullable(),
    completed_at: z.string().nullable(),
    app: z.object({ slug: z.string() }).nullable(),
  })
  .transform((run) => ({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    htmlUrl: run.html_url,
    detailsUrl: run.details_url,
    completedAt: run.completed_at,
    app: run.app?.slug ?? null,
  }));
export type CheckRun = z.output<typeof CheckRunWireSchema>;

const CheckRunPageWireSchema = z
  .object({ total_count: z.number(), check_runs: z.array(CheckRunWireSchema) })
  .transform((page) => ({ totalCount: page.total_count, checkRuns: page.check_runs }));

const CombinedStatusWireSchema = z
  .object({
    state: z.string(),
    total_count: z.number(),
    statuses: z.array(
      z
        .object({ context: z.string(), state: z.string(), description: z.string().nullable(), target_url: z.string().nullable() })
        .transform((status) => ({ context: status.context, state: status.state, description: status.description, targetUrl: status.target_url })),
    ),
  })
  .transform((combined) => ({ state: combined.state, totalCount: combined.total_count, statuses: combined.statuses }));
export type CombinedStatus = z.output<typeof CombinedStatusWireSchema>;

export interface HeadChecks {
  /** Check runs on the head, without this workflow run's own jobs. */
  runs: CheckRun[];
  /** Combined commit status; `totalCount` 0 means no status contexts are reported. */
  status: CombinedStatus;
}

/** The CI state of a commit. */
export interface HeadChecksSource {
  load(sha: string): Promise<HeadChecks>;
}

const GitHubHeadChecksPropsSchema = z.object({
  client: z.custom<Pick<GitHubClient, "get">>((value) => typeof value === "object" && value !== null && "get" in value),
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  /** This workflow run's id; its own jobs are left out. Empty keeps every run. */
  runId: z.string().default(""),
});
export type GitHubHeadChecksProps = z.input<typeof GitHubHeadChecksPropsSchema>;

/** Every check run (all pages) and the combined commit status on a commit, read from the GitHub API. */
export class GitHubHeadChecks implements HeadChecksSource {
  private readonly props: z.output<typeof GitHubHeadChecksPropsSchema>;

  constructor(props: GitHubHeadChecksProps) {
    this.props = GitHubHeadChecksPropsSchema.parse(props);
  }

  async load(sha: string): Promise<HeadChecks> {
    const { client, repo, runId } = this.props;

    const runs: CheckRun[] = [];
    for (let page = 1; ; page++) {
      const { totalCount, checkRuns } = CheckRunPageWireSchema.parse(
        await client.get(`/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`),
      );
      runs.push(...checkRuns);
      if (checkRuns.length === 0 || runs.length >= totalCount) break;
    }

    const status = CombinedStatusWireSchema.parse(await client.get(`/repos/${repo}/commits/${sha}/status?per_page=100`));

    return { runs: runs.filter((run) => !ownRun(run, runId)), status };
  }
}

const PASSED = ["success", "neutral", "skipped"];

/** True for a check run that belongs to this workflow run (the review job itself or its siblings). */
export function ownRun(run: Pick<CheckRun, "detailsUrl">, runId: string): boolean {
  return runId !== "" && (run.detailsUrl?.includes(`/actions/runs/${runId}/`) ?? false);
}

/** True when every check run and status context on the head has passed. */
export function checksGreen(checks: HeadChecks): { green: boolean; reason: string } {
  const pending = checks.runs.filter((run) => run.status !== "completed");
  if (pending.length > 0) return { green: false, reason: `${pending.map((run) => run.name).join(", ")} still running` };
  const failed = checks.runs.filter((run) => !PASSED.includes(run.conclusion ?? ""));
  if (failed.length > 0) return { green: false, reason: `${failed.map((run) => run.name).join(", ")} did not pass` };
  if (checks.status.totalCount > 0 && checks.status.state !== "success")
    return { green: false, reason: `commit status is ${checks.status.state}` };
  return { green: true, reason: "" };
}

/** `checks.json` as the reviewer reads it: snake_case like the contract's `check_run_id` evidence field. */
const ChecksFileSchema = z
  .object({
    headSha: z.string(),
    fetchedAt: z.string(),
    available: z.boolean(),
    note: z.string(),
    pending: z.number(),
    checkRuns: z.array(
      z.object({
        checkRunId: z.number(),
        name: z.string(),
        app: z.string().nullable(),
        status: z.string(),
        conclusion: z.string().nullable(),
        url: z.string().nullable(),
        completedAt: z.string().nullable(),
      }),
    ),
    commitStatus: z.object({
      state: z.string(),
      statuses: z.array(z.object({ context: z.string(), state: z.string(), description: z.string().nullable(), url: z.string().nullable() })),
    }),
  })
  .transform((file) => ({
    head_sha: file.headSha,
    fetched_at: file.fetchedAt,
    available: file.available,
    note: file.note,
    pending: file.pending,
    check_runs: file.checkRuns.map((run) => ({
      check_run_id: run.checkRunId,
      name: run.name,
      app: run.app,
      status: run.status,
      conclusion: run.conclusion,
      url: run.url,
      completed_at: run.completedAt,
    })),
    commit_status: file.commitStatus,
  }));
export type ChecksFile = z.output<typeof ChecksFileSchema>;

/**
 * The reviewer's view of CI on the head: what ran, what passed and what is still pending. A load error
 * yields an explicit "unavailable" file, so a missing Checks permission or an API outage leaves CI
 * unverified instead of stopping the review.
 */
export function checksFile(checks: HeadChecks | Error, sha: string, fetchedAt: string): ChecksFile {
  if (checks instanceof Error)
    return ChecksFileSchema.parse({
      headSha: sha,
      fetchedAt,
      available: false,
      note: `CI state could not be fetched (${checks.message}). Treat every CI outcome as unverified.`,
      pending: 0,
      checkRuns: [],
      commitStatus: { state: "unknown", statuses: [] },
    });
  return ChecksFileSchema.parse({
    headSha: sha,
    fetchedAt,
    available: true,
    note:
      "Snapshot taken before the review started; CI often runs alongside this review, so pending entries are normal. " +
      "Only a check run with status completed and conclusion success can be cited, as check_run evidence with its check_run_id. " +
      "This review's own jobs are excluded.",
    pending:
      checks.runs.filter((run) => run.status !== "completed").length +
      checks.status.statuses.filter((status) => status.state === "pending").length,
    checkRuns: checks.runs.map((run) => ({
      checkRunId: run.id,
      name: run.name,
      app: run.app,
      status: run.status,
      conclusion: run.conclusion,
      url: run.htmlUrl ?? run.detailsUrl,
      completedAt: run.completedAt,
    })),
    commitStatus: {
      state: checks.status.totalCount > 0 ? checks.status.state : "none",
      statuses: checks.status.statuses.map((status) => ({
        context: status.context,
        state: status.state,
        description: status.description,
        url: status.targetUrl,
      })),
    },
  });
}
