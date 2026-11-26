import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EvidenceReviewPlanner, reviewContract } from "@good-ground-collective/flight-rules/review";
import type { FindingRecord, PriorFinding, Review, ReviewOutcome, StoredFinding } from "@good-ground-collective/flight-rules/review";
import { ActionReviewVerifier } from "./authority.js";
import { checksGreen, loadChecks } from "./checks.js";
import { readStructuredOutput } from "./execution.js";
import type { GatherState } from "./gather.js";
import { gateExitCode } from "./gate.js";
import { GitHubClient } from "./github.js";
import { PostInputSchema } from "./inputs.js";
import { activeChangesRequested, publish, resolveThreads } from "./publish.js";
import { loadPull, loadSnapshot } from "./pull-request.js";
import { FlightRulesExtensionSchema, strictProblems } from "./strict.js";
import { informationalEntries, renderSummary, type PublishedRecord } from "./summary.js";

async function main(): Promise<number> {
  const input = PostInputSchema.parse(process.env);
  const repo = input.GITHUB_REPOSITORY;
  const log = (line: string): void => console.log(line);
  const client = new GitHubClient({
    token: input.GH_TOKEN,
    apiUrl: input.GITHUB_API_URL,
    graphqlUrl: input.GITHUB_GRAPHQL_URL,
    dryRun: input.DRY_RUN,
    log,
  });
  const gathered = JSON.parse(readFileSync(join(input.OUT_DIR, "gather-state.json"), "utf8")) as GatherState;
  if (gathered.skipReason !== "") {
    log(`No review posted: ${gathered.skipReason}`);
    return 0;
  }
  const headSha = gathered.headSha;
  const recovered = gathered.recovered;
  const problems = [...recovered.problems];
  const notes = [...recovered.notes];
  if (gathered.incompleteReason !== "") problems.push(gathered.incompleteReason);

  let review: Review | undefined;
  let records: FindingRecord[] = recovered.records.map((entry) => entry.record);
  let added: StoredFinding[] = [];
  let outcome: ReviewOutcome = "INCOMPLETE";
  if (gathered.incompleteReason === "") {
    const execution = readStructuredOutput(input.EXECUTION_FILE);
    if (!execution.ok) problems.push(execution.reason);
    else {
      try {
        const candidate = reviewContract.parse(execution.output);
        const open = new Set(recovered.records.filter((entry) => entry.record.status === "open").map((entry) => entry.record.finding.id));
        const unknown = candidate.prior_findings.filter((entry) => !open.has(entry.id));
        for (const entry of unknown) problems.push(`the reviewer returned an entry for unknown or closed finding ${entry.id}`);
        review = { ...candidate, prior_findings: candidate.prior_findings.filter((entry) => open.has(entry.id)) };
        problems.push(...strictProblems({ review, tierA: gathered.tierA, charters: gathered.charters }));
        const planner = new EvidenceReviewPlanner({
          verifier: new ActionReviewVerifier({
            client,
            repo,
            prNumber: gathered.prNumber,
            prAuthorId: (await loadPull(client, repo, gathered.prNumber)).user.id,
            policy: gathered.policy,
          }),
        });
        const plan = await planner.plan({ review, records, headSha });
        records = plan.records;
        added = plan.informational;
        outcome = plan.outcome;
        problems.push(...plan.problems);
      } catch (error) {
        problems.push(`the review result was rejected: ${(error as Error).message}`);
      }
    }
  }

  // Per-PR serialization is the caller's concurrency group; still never write against a moved head.
  const current = await loadPull(client, repo, gathered.prNumber);
  if (current.head.sha !== headSha) {
    log(`::notice::PR head moved from ${headSha.slice(0, 7)} to ${current.head.sha.slice(0, 7)}; discarding this stale pass`);
    return 0;
  }
  const snapshot = await loadSnapshot(client, repo, gathered.prNumber);
  const result = await publish({
    client,
    repo,
    snapshot,
    headSha,
    botId: gathered.botId,
    recovered: recovered.records,
    planned: records,
    priorEntries: (review?.prior_findings ?? []) as PriorFinding[],
    outcome,
    requestChanges: input.REQUEST_CHANGES,
    summaryUrl: gathered.summaryUrl,
    log,
  });
  problems.push(...result.problems);
  const published: PublishedRecord[] = result.records;
  const finalOutcome: ReviewOutcome = problems.length > 0 ? "INCOMPLETE" : outcome;
  const coverage = FlightRulesExtensionSchema.safeParse(review?.extensions?.flight_rules);
  const runUrl = input.GITHUB_RUN_ID ? `${input.GITHUB_SERVER_URL}/${repo}/actions/runs/${input.GITHUB_RUN_ID}` : undefined;
  const render = (shown: ReviewOutcome): string =>
    renderSummary({
      outcome: shown,
      headSha,
      reviewSummary: review?.summary,
      outcomeReason: review?.outcome_reason,
      remainingRisk: review?.remaining_risk,
      problems,
      notes,
      records: published,
      informational: informationalEntries(recovered.informational, added),
      unrecovered: recovered.unrecovered,
      transitions: result.transitions,
      coverage: coverage.success ? coverage.data : undefined,
      trustedRef: gathered.trustedRef || undefined,
      runUrl,
      model: input.MODEL || undefined,
    });

  // recoverState only offers a readable summary; unreadable ones are left untouched.
  let summaryId = recovered.summaryCommentId;
  const saveSummary = async (body: string): Promise<boolean> => {
    try {
      if (summaryId !== null) await client.write("PATCH", `/repos/${repo}/issues/comments/${summaryId}`, { body });
      else summaryId = (await client.write<{ id: number }>("POST", `/repos/${repo}/issues/${gathered.prNumber}/comments`, { body })).id;
      return true;
    } catch (error) {
      problems.push(`could not save the summary and state: ${(error as Error).message}`);
      return false;
    }
  };

  let summary = render(finalOutcome);
  const stateSaved = await saveSummary(summary);
  let gated: ReviewOutcome = stateSaved ? finalOutcome : "INCOMPLETE";
  if (stateSaved) {
    const unresolved = await resolveThreads(client, result.resolutions);
    for (const problem of unresolved) log(`::warning::${problem}`);
  }
  if (gated === "APPROVED") {
    const latest = await loadPull(client, repo, gathered.prNumber);
    if (latest.head.sha !== headSha) {
      problems.push("the PR head moved before the final gate review");
    } else {
      try {
        const ci = input.APPROVE ? checksGreen(await loadChecks(client, repo, headSha, input.GITHUB_RUN_ID)) : { green: false, reason: "" };
        if (input.APPROVE && !ci.green) log(`::notice::approval withheld until CI is green (${ci.reason}); dismissing the change request instead`);
        if (input.APPROVE && ci.green)
          await client.write("POST", `/repos/${repo}/pulls/${gathered.prNumber}/reviews`, {
            commit_id: headSha,
            event: "APPROVE",
            body: `**flight-rules review** of \`${headSha.slice(0, 7)}\`: nothing blocking is open.`,
          });
        else
          for (const stale of activeChangesRequested(snapshot.reviews, gathered.botId))
            await client.write("PUT", `/repos/${repo}/pulls/${gathered.prNumber}/reviews/${stale.id}/dismissals`, {
              message: `Resolved at ${headSha.slice(0, 7)}: nothing blocking is open.`,
              event: "DISMISS",
            });
      } catch (error) {
        problems.push(`could not submit the final gate review: ${(error as Error).message}`);
      }
    }
    if (problems.length > 0) {
      // The saved state must not claim APPROVED when the gate did not land.
      gated = "INCOMPLETE";
      summary = render(gated);
      await saveSummary(summary);
    }
  }

  if (input.GITHUB_STEP_SUMMARY) appendFileSync(input.GITHUB_STEP_SUMMARY, `${summary.replace(/<!-- code-review:state [\s\S]*? -->/, "")}\n`);
  for (const problem of problems) log(`::warning::${problem}`);
  log(`Outcome: ${gated}`);
  if (input.GITHUB_OUTPUT) appendFileSync(input.GITHUB_OUTPUT, `outcome=${gated}\n`);
  return gateExitCode(gated, input.FAIL_ON);
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`::error::${(error as Error).stack ?? String(error)}`);
    process.exit(1);
  },
);
