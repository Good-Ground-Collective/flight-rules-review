import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
import {
  ActionReviewVerifier,
  EvidenceReviewPlanner,
  FlightRulesExtensionSchema,
  GitHubClient,
  GitHubError,
  JsonReviewCodec,
  PostInputSchema,
  SUMMARY_MARKER,
  checksGreen,
  loadChecks,
  loadPull,
  loadSnapshot,
  reviewContract,
  strictProblems
} from "./chunks/chunk-76YX23S6.mjs";

// src/post.ts
import { appendFileSync, readFileSync as readFileSync2 } from "node:fs";
import { join } from "node:path";

// src/execution.ts
import { existsSync, readFileSync } from "node:fs";
function readStructuredOutput(file) {
  if (file === "" || !existsSync(file)) return { ok: false, reason: "the reviewer produced no execution transcript" };
  let messages;
  try {
    messages = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, reason: "the reviewer transcript is not valid JSON" };
  }
  if (!Array.isArray(messages)) return { ok: false, reason: "the reviewer transcript is not a message list" };
  const result = [...messages].reverse().find(
    (message) => typeof message === "object" && message !== null && message.type === "result"
  );
  if (result === void 0) return { ok: false, reason: "the reviewer did not finish (no result message)" };
  if (result.is_error || result.subtype && result.subtype !== "success")
    return { ok: false, reason: `the reviewer ended with ${result.subtype ?? "an error"}` };
  if (result.structured_output === void 0 || result.structured_output === null)
    return { ok: false, reason: "the reviewer returned no structured review" };
  return { ok: true, output: result.structured_output };
}

// src/gate.ts
function gateExitCode(outcome, failOn) {
  if (failOn === "never") return 0;
  if (failOn === "incomplete") return outcome === "INCOMPLETE" ? 1 : 0;
  if (outcome !== "APPROVED") {
    console.log(`::error::flight-rules review outcome is ${outcome}`);
    return 1;
  }
  return 0;
}

// src/diff.ts
function commentableLines(patch) {
  const hunks = [];
  if (patch === void 0) return { hunks };
  let current = null;
  let right = 0;
  for (const line2 of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line2);
    if (header) {
      current = [];
      hunks.push(current);
      right = Number(header[1]);
      continue;
    }
    if (current === null || line2.startsWith("\\")) continue;
    if (line2.startsWith("-")) continue;
    current.push(right);
    right++;
  }
  return { hunks };
}
function place(finding, files) {
  const file = files.get(finding.path);
  if (finding.path === "" || file === void 0) return { kind: "body" };
  if (finding.line > 0) {
    const hunk = file.hunks.find((lines) => lines.includes(finding.line));
    if (hunk !== void 0) {
      const start = finding.start_line;
      if (start !== void 0 && start > 0 && start < finding.line && hunk.includes(start))
        return { kind: "inline", path: finding.path, line: finding.line, startLine: start };
      return { kind: "inline", path: finding.path, line: finding.line };
    }
  }
  return { kind: "file", path: finding.path };
}
function hunkIndex(files) {
  return new Map(
    files.filter((file) => file.status !== "removed").map((file) => [file.filename, commentableLines(file.patch)])
  );
}

// src/publish.ts
var BODY_BUDGET = 6e4;
var BLOCKING = ["CHANGES_NEEDED", "ESCALATE"];
var codec = new JsonReviewCodec();
function shortSha(sha) {
  return sha.slice(0, 7);
}
function chunkBodies(header, rendered) {
  const chunks = [];
  let current = [];
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
function activeChangesRequested(reviews, botId) {
  const mine = reviews.filter((review) => review.user?.id === botId && review.state !== "COMMENTED" && review.state !== "PENDING");
  const latest = mine.at(-1);
  return latest?.state === "CHANGES_REQUESTED" ? mine.filter((review) => review.state === "CHANGES_REQUESTED") : [];
}
function transitionReply(prior, next, entry, headSha) {
  const reason = entry?.reason ?? "";
  if (prior.status === "open" && next.status === "resolved") return `**Resolved** at \`${shortSha(headSha)}\`: ${reason}`;
  if (prior.status === "open" && next.status === "withdrawn")
    return `**Withdrawn** (${entry?.status === "withdrawn" ? entry.withdrawal_basis.replaceAll("_", " ") : "withdrawn"}): ${reason}`;
  if (JSON.stringify(prior.finding) !== JSON.stringify(next.finding) || JSON.stringify(prior.decision) !== JSON.stringify(next.decision)) {
    const previous = codec.render(prior).replace("<!-- code-review:finding ", "<!-- flight-rules-review:previous ");
    return `**Updated** at \`${shortSha(headSha)}\`: ${reason}

<details>
<summary>Previous version</summary>

${previous}

</details>`;
  }
  if (entry?.status === "still_open" && entry.reply) return entry.reply;
  return null;
}
function markerId(body) {
  try {
    return codec.parseFinding(body ?? "")?.finding.id;
  } catch {
    return void 0;
  }
}
function threadsFor(snapshot, botId, findingId, location) {
  const roots = new Set(
    snapshot.reviewComments.filter((comment) => comment.user?.id === botId && comment.in_reply_to_id === void 0 && markerId(comment.body) === findingId).map((comment) => comment.id)
  );
  if (location.kind === "review_comment") roots.add(location.comment_id);
  return snapshot.threads.filter((thread) => !thread.isResolved && thread.rootCommentId !== null && roots.has(thread.rootCommentId)).map((thread) => thread.id);
}
function inlineComment(placement, body) {
  return {
    path: placement.path,
    line: placement.line,
    side: "RIGHT",
    ...placement.startLine !== void 0 ? { start_line: placement.startLine, start_side: "RIGHT" } : {},
    body
  };
}
async function publish(input) {
  const { client, repo, snapshot, headSha } = input;
  const number = snapshot.pull.number;
  const problems = [];
  const resolutions = [];
  const transitions = [];
  const recoveredById = new Map(input.recovered.map((entry) => [entry.record.finding.id, entry]));
  const entries = new Map(input.priorEntries.map((entry) => [entry.id, entry]));
  const published = [];
  const accept = (update) => {
    published.push({ record: update.next, location: update.prior.location, url: update.prior.url });
    if (update.changed)
      transitions.push({
        id: update.next.finding.id,
        from: update.prior.record.status,
        to: update.next.status,
        updated: JSON.stringify(update.prior.record.finding) !== JSON.stringify(update.next.finding),
        reason: update.reason
      });
  };
  const keep = (update) => {
    published.push({ record: update.prior.record, location: update.prior.location, url: update.prior.url });
  };
  const reply = async (update) => {
    if (update.reply === null) return;
    const location = update.prior.location;
    try {
      if (location.kind === "review_comment")
        await client.write("POST", `/repos/${repo}/pulls/${number}/comments/${location.comment_id}/replies`, { body: update.reply });
      else
        await client.write("POST", `/repos/${repo}/issues/${number}/comments`, {
          body: `**${update.next.finding.id}** (${update.next.finding.subject})

${update.reply}`
        });
    } catch (error) {
      problems.push(`could not post the reply for ${update.next.finding.id}: ${error.message}`);
    }
  };
  const bodyGroups = /* @__PURE__ */ new Map();
  for (const next of input.planned) {
    const prior = recoveredById.get(next.finding.id);
    if (prior === void 0) continue;
    const entry = entries.get(next.finding.id);
    const update = {
      prior,
      next,
      changed: JSON.stringify(prior.record) !== JSON.stringify(next),
      reply: transitionReply(prior.record, next, entry, headSha),
      reason: entry?.reason ?? ""
    };
    if (prior.location.kind === "review_body") {
      bodyGroups.set(prior.location.review_id, [...bodyGroups.get(prior.location.review_id) ?? [], update]);
      continue;
    }
    if (update.changed) {
      try {
        await client.write("PATCH", `/repos/${repo}/pulls/comments/${prior.location.comment_id}`, { body: codec.render(next) });
      } catch (error) {
        problems.push(`could not persist the update to ${next.finding.id}: ${error.message}`);
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
        body: [header, ...updates.map((update) => codec.render(update.next))].join("\n\n---\n\n")
      });
      for (const update of updates) {
        accept(update);
        await reply(update);
      }
    } catch (error) {
      problems.push(`could not update the findings in review ${reviewId}: ${error.message}`);
      for (const update of updates) keep(update);
    }
  }
  const files = hunkIndex(snapshot.files);
  const fresh = input.planned.filter((record) => !recoveredById.has(record.finding.id));
  const inline = [];
  const fileLevel = [];
  const body = [];
  for (const record of fresh) {
    const placement = place(record.finding, files);
    if (placement.kind === "inline") inline.push({ record, placement });
    else if (placement.kind === "file") fileLevel.push({ record, path: placement.path });
    else body.push(record);
  }
  const knownReviews = new Set(snapshot.reviews.map((review) => review.id));
  const knownComments = new Set(snapshot.reviewComments.map((comment) => comment.id));
  const landed = async (what, path, match) => {
    if (client.dryRun) return void 0;
    try {
      return (await client.paginate(path)).find(match);
    } catch (error) {
      input.log(`could not check whether the failed ${what} was created: ${error.message}`);
      return null;
    }
  };
  const landedReview = (body2) => landed(
    "review",
    `/repos/${repo}/pulls/${number}/reviews`,
    (review) => !knownReviews.has(review.id) && review.user?.id === input.botId && review.commit_id === headSha && (review.body ?? "").trim() === body2.trim()
  );
  const landedComment = (record) => landed(
    "comment",
    `/repos/${repo}/pulls/${number}/comments`,
    (comment) => !knownComments.has(comment.id) && comment.user?.id === input.botId && comment.in_reply_to_id === void 0 && markerId(comment.body) === record.finding.id
  );
  const postFileLevel = async (record, path) => {
    let comment;
    try {
      comment = await client.write("POST", `/repos/${repo}/pulls/${number}/comments`, {
        body: codec.render(record),
        commit_id: headSha,
        path,
        subject_type: "file"
      });
    } catch (error) {
      const found = await landedComment(record);
      if (found === null) return "unknown";
      if (found === void 0) {
        input.log(`file-level comment for ${record.finding.id} failed, moving it to the review body: ${error.message}`);
        return "failed";
      }
      input.log(`file-level comment for ${record.finding.id} reported an error but was created: ${error.message}`);
      comment = found;
    }
    knownComments.add(comment.id);
    published.push({ record, location: { kind: "review_comment", comment_id: comment.id }, url: comment.html_url });
    return "posted";
  };
  for (const { record, path } of fileLevel) if (await postFileLevel(record, path) === "failed") body.push(record);
  const blocking = BLOCKING.includes(input.outcome);
  const event = blocking && input.requestChanges ? "REQUEST_CHANGES" : "COMMENT";
  const needsGateReview = blocking && input.requestChanges && activeChangesRequested(snapshot.reviews, input.botId).length === 0;
  if (inline.length > 0 || body.length > 0 || needsGateReview) {
    const header = [
      `**flight-rules review** of \`${shortSha(headSha)}\`: ${fresh.length} new finding${fresh.length === 1 ? "" : "s"}.`,
      blocking ? `This PR has open blocking findings; see the [summary](${input.summaryUrl}) for everything that remains.` : `See the [summary](${input.summaryUrl}).`
    ].join(" ");
    const index = (record, location, url) => {
      if (!published.some((entry) => entry.record.finding.id === record.finding.id)) published.push({ record, location, url });
    };
    const postChunks = async (comments, bodyRecords) => {
      const chunks = chunkBodies(header, bodyRecords.map((record) => codec.render(record)));
      if (chunks.length === 0) chunks.push(header);
      for (const [position, chunk] of chunks.entries()) {
        let review;
        try {
          review = await client.write("POST", `/repos/${repo}/pulls/${number}/reviews`, {
            commit_id: headSha,
            event: position === chunks.length - 1 ? event : "COMMENT",
            body: chunk,
            comments: position === 0 ? comments.map(({ record, placement }) => inlineComment(placement, codec.render(record))) : []
          });
        } catch (error) {
          const found = await landedReview(chunk);
          if (found === null || found === void 0) return { failed: position, error, unknown: found === null };
          input.log(`review ${found.id} was created although GitHub reported an error: ${error.message}`);
          review = found;
        }
        knownReviews.add(review.id);
        for (const record of bodyRecords)
          if (chunk.includes(`"id":"${record.finding.id}"`)) index(record, { kind: "review_body", review_id: review.id }, review.html_url);
        if (position === 0 && comments.length > 0) {
          const posted = client.dryRun ? comments.map(({ record }, offset) => ({ id: review.id + offset + 1, body: codec.render(record), html_url: review.html_url })) : await client.paginate(`/repos/${repo}/pulls/${number}/reviews/${review.id}/comments`);
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
    if (attempt.failed === 0 && attempt.unknown !== true && inline.length > 0 && attempt.error instanceof GitHubError && attempt.error.status === 422) {
      input.log(`inline review rejected (${attempt.error.detail}); retrying with file-level placement`);
      const demoted = [...body];
      for (const { record, placement } of inline) if (await postFileLevel(record, placement.path) === "failed") demoted.push(record);
      attempt = await postChunks([], demoted);
    }
    if (attempt.failed >= 0) problems.push(`could not submit the findings review: ${attempt.error.message}`);
  }
  for (const entry of published) {
    if (entry.record.status === "open") continue;
    for (const thread of threadsFor(snapshot, input.botId, entry.record.finding.id, entry.location))
      if (!resolutions.includes(thread)) resolutions.push(thread);
  }
  const missing = fresh.filter(
    (record) => !published.some((entry) => entry.record.finding.id === record.finding.id)
  );
  for (const record of missing) problems.push(`new finding ${record.finding.id} was not published`);
  return { records: published, transitions, problems, resolutions };
}
async function resolveThreads(client, threadIds) {
  const problems = [];
  for (const threadId of threadIds) {
    try {
      await client.writeGraphql(
        "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}",
        { id: threadId }
      );
    } catch (error) {
      problems.push(`could not resolve thread ${threadId}: ${error.message}`);
    }
  }
  return problems;
}

// src/summary.ts
var SUMMARY_BUDGET = 6e4;
var OUTCOME_ALERT = {
  APPROVED: { kind: "TIP", title: "Approved", fallback: "Nothing blocking is open." },
  CHANGES_NEEDED: { kind: "CAUTION", title: "Changes needed", fallback: "Blocking fixes or questions are open." },
  ESCALATE: { kind: "IMPORTANT", title: "Escalated: a human decision is needed", fallback: "A blocking decision is open." },
  INCOMPLETE: { kind: "WARNING", title: "Incomplete", fallback: "The review did not complete." }
};
function link(entry) {
  return `[\`${entry.record.finding.id}\`](${entry.url})`;
}
function line(entry) {
  const finding = entry.record.finding;
  const where = finding.path === "" ? "PR-wide" : `\`${finding.path}${finding.line > 0 ? `:${finding.line}` : ""}\``;
  return `| ${link(entry)} | ${finding.label} \xB7 ${finding.severity} | ${escapeCell(finding.subject)} | ${where} |`;
}
function escapeCell(text) {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}
function table(entries) {
  return ["| Finding | Label | Subject | Where |", "| --- | --- | --- | --- |", ...entries.map(line)].join("\n");
}
function fold(title, body) {
  return `<details>
<summary>${title}</summary>

${body}

</details>`;
}
function stateIndex(input) {
  return {
    v: 1,
    schema_revision: 1,
    sha: input.headSha,
    outcome: input.outcome,
    records: [
      ...input.records.map((entry) => ({ id: entry.record.finding.id, status: entry.record.status, location: entry.location })),
      ...(input.unrecovered ?? []).filter((entry) => !input.records.some((rec) => rec.record.finding.id === entry.id)),
      ...input.informational
    ]
  };
}
function informationalEntries(previous, added) {
  const codec2 = new JsonReviewCodec();
  const seen = new Set(previous.map((entry) => entry.fingerprint));
  const entries = [...previous];
  for (const finding of added) {
    const fingerprint = codec2.fingerprint(finding);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    entries.push({ id: finding.id, status: "informational", fingerprint, finding });
  }
  return entries;
}
function renderSummary(input) {
  const codec2 = new JsonReviewCodec();
  const open = input.records.filter((entry) => entry.record.status === "open");
  const blocking = open.filter((entry) => entry.record.finding.blocking);
  const decisions = blocking.filter((entry) => entry.record.finding.type === "decide");
  const fixes = blocking.filter((entry) => entry.record.finding.type === "fix");
  const questions = blocking.filter((entry) => entry.record.finding.type === "clarify");
  const optional = open.filter((entry) => !entry.record.finding.blocking);
  const alert = OUTCOME_ALERT[input.outcome];
  const reason = input.outcome === "INCOMPLETE" ? `${input.problems.length > 0 ? input.problems.map((problem) => `- ${problem}`).join("\n> ") : alert.fallback}
>
> Re-run the review workflow after fixing the cause. Open findings below still stand.` : input.outcomeReason ?? alert.fallback;
  const head = [
    SUMMARY_MARKER,
    "## flight-rules review",
    "",
    `> [!${alert.kind}]
> **${alert.title}.** ${input.outcome === "INCOMPLETE" ? "\n> " : ""}${reason}`,
    "",
    `Reviewed \`${input.headSha.slice(0, 7)}\` in strict comprehensive mode \xB7 ${blocking.length} blocking \xB7 ${optional.length} optional${input.model ? ` \xB7 ${input.model}` : ""}${input.runUrl ? ` \xB7 [run](${input.runUrl})` : ""}`
  ];
  if (input.reviewSummary) head.push("", input.reviewSummary);
  const sections = [];
  if (decisions.length > 0)
    sections.push(
      "### Decisions needed",
      "",
      ...decisions.map((entry) => {
        const finding = entry.record.finding;
        return `- ${link(entry)} ${finding.subject}: owner **${finding.type === "decide" ? finding.decision_owner : ""}**`;
      })
    );
  if (fixes.length > 0) sections.push(...sections.length > 0 ? [""] : [], "### Required fixes", "", table(fixes));
  if (questions.length > 0) sections.push(...sections.length > 0 ? [""] : [], "### Open questions", "", table(questions));
  const optionalSection = [];
  if (optional.length > 0) {
    const counts = /* @__PURE__ */ new Map();
    for (const entry of optional) counts.set(entry.record.finding.label, (counts.get(entry.record.finding.label) ?? 0) + 1);
    optionalSection.push(
      "### Optional improvements",
      "",
      [...counts].map(([label, count]) => `${count} ${label}`).join(" \xB7 "),
      "",
      fold("Show optional findings", table(optional))
    );
  }
  const progress = [];
  if (input.transitions.length > 0)
    progress.push(
      "### Progress since the last pass",
      "",
      ...input.transitions.map(
        (transition) => `- \`${transition.id}\` ${transition.updated && transition.from === transition.to ? "updated" : `${transition.from} \u2192 ${transition.to}`}: ${transition.reason}`
      )
    );
  const risk = input.remainingRisk ? ["### Remaining risk", "", input.remainingRisk] : [];
  const notes = input.notes.length > 0 ? [fold("Reconciliation notes", input.notes.map((note) => `- ${note}`).join("\n"))] : [];
  const coverage = input.coverage ? [
    fold(
      `Charter coverage: ${input.coverage.charterCoverage.charters.join(", ")} \xB7 Tier A ${input.coverage.counts.tierA} \xB7 Tier B ${input.coverage.counts.tierB} \xB7 holistic ${input.coverage.counts.holistic}`,
      [
        `Lint: ${input.coverage.lint.status}. ${input.coverage.lint.detail}`,
        input.trustedRef ? `Repository rules read from \`${input.trustedRef.slice(0, 12)}\`.` : "",
        "",
        "| Mandate | Charter | State | Files |",
        "| --- | --- | --- | --- |",
        ...input.coverage.charterCoverage.mandates.map(
          (mandate) => `| ${mandate.id} | ${mandate.charter} | ${mandate.state} | ${mandate.files.length > 0 ? escapeCell(mandate.files.join(", ")) : "none"} |`
        )
      ].join("\n")
    )
  ] : [];
  const informational = input.informational.filter((entry) => entry.finding !== void 0);
  const notesSection = informational.length > 0 ? [
    fold(
      `Notes and praise (${informational.length})`,
      informational.map((entry) => `- **${entry.finding.label}:** ${entry.finding.subject}${entry.finding.path ? ` (\`${entry.finding.path}\`)` : ""}`).join("\n")
    )
  ] : [];
  const markerFor = (entries) => codec2.state(
    stateIndex({ headSha: input.headSha, outcome: input.outcome, records: input.records, informational: entries, unrecovered: input.unrecovered })
  );
  const compose = (parts, marker2) => [head.join("\n"), ...parts.filter((part) => part.length > 0).map((part) => part.join("\n")), marker2].join("\n\n");
  const marker = markerFor(input.informational);
  const ladder = [
    [sections, optionalSection, progress, risk, notesSection, coverage, notes],
    [sections, optionalSection.slice(0, 2), progress, risk, coverage],
    [sections, optionalSection.slice(0, 2), risk],
    [sections.slice(0, 1), risk],
    []
  ];
  for (const parts of ladder) {
    const body = compose(parts, marker);
    if (body.length <= SUMMARY_BUDGET) return body;
  }
  const compact = input.informational.map(({ id, status, fingerprint }) => ({ id, status, fingerprint }));
  return compose([], markerFor(compact));
}

// src/post.ts
async function main() {
  const input = PostInputSchema.parse(process.env);
  const repo = input.GITHUB_REPOSITORY;
  const log = (line2) => console.log(line2);
  const client = new GitHubClient({
    token: input.GH_TOKEN,
    apiUrl: input.GITHUB_API_URL,
    graphqlUrl: input.GITHUB_GRAPHQL_URL,
    dryRun: input.DRY_RUN,
    log
  });
  const gathered = JSON.parse(readFileSync2(join(input.OUT_DIR, "gather-state.json"), "utf8"));
  if (gathered.skipReason !== "") {
    log(`No review posted: ${gathered.skipReason}`);
    return 0;
  }
  const headSha = gathered.headSha;
  const recovered = gathered.recovered;
  const problems = [...recovered.problems];
  const notes = [...recovered.notes];
  if (gathered.incompleteReason !== "") problems.push(gathered.incompleteReason);
  let review;
  let records = recovered.records.map((entry) => entry.record);
  let added = [];
  let outcome = "INCOMPLETE";
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
            policy: gathered.policy
          })
        });
        const plan = await planner.plan({ review, records, headSha });
        records = plan.records;
        added = plan.informational;
        outcome = plan.outcome;
        problems.push(...plan.problems);
      } catch (error) {
        problems.push(`the review result was rejected: ${error.message}`);
      }
    }
  }
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
    priorEntries: review?.prior_findings ?? [],
    outcome,
    requestChanges: input.REQUEST_CHANGES,
    summaryUrl: gathered.summaryUrl,
    log
  });
  problems.push(...result.problems);
  const published = result.records;
  const finalOutcome = problems.length > 0 ? "INCOMPLETE" : outcome;
  const coverage = FlightRulesExtensionSchema.safeParse(review?.extensions?.flight_rules);
  const runUrl = input.GITHUB_RUN_ID ? `${input.GITHUB_SERVER_URL}/${repo}/actions/runs/${input.GITHUB_RUN_ID}` : void 0;
  const render = (shown) => renderSummary({
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
    coverage: coverage.success ? coverage.data : void 0,
    trustedRef: gathered.trustedRef || void 0,
    runUrl,
    model: input.MODEL || void 0
  });
  let summaryId = recovered.summaryCommentId;
  const saveSummary = async (body) => {
    try {
      if (summaryId !== null) await client.write("PATCH", `/repos/${repo}/issues/comments/${summaryId}`, { body });
      else summaryId = (await client.write("POST", `/repos/${repo}/issues/${gathered.prNumber}/comments`, { body })).id;
      return true;
    } catch (error) {
      problems.push(`could not save the summary and state: ${error.message}`);
      return false;
    }
  };
  let summary = render(finalOutcome);
  const stateSaved = await saveSummary(summary);
  let gated = stateSaved ? finalOutcome : "INCOMPLETE";
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
            body: `**flight-rules review** of \`${headSha.slice(0, 7)}\`: nothing blocking is open.`
          });
        else
          for (const stale of activeChangesRequested(snapshot.reviews, gathered.botId))
            await client.write("PUT", `/repos/${repo}/pulls/${gathered.prNumber}/reviews/${stale.id}/dismissals`, {
              message: `Resolved at ${headSha.slice(0, 7)}: nothing blocking is open.`,
              event: "DISMISS"
            });
      } catch (error) {
        problems.push(`could not submit the final gate review: ${error.message}`);
      }
    }
    if (problems.length > 0) {
      gated = "INCOMPLETE";
      summary = render(gated);
      await saveSummary(summary);
    }
  }
  if (input.GITHUB_STEP_SUMMARY) appendFileSync(input.GITHUB_STEP_SUMMARY, `${summary.replace(/<!-- code-review:state [\s\S]*? -->/, "")}
`);
  for (const problem of problems) log(`::warning::${problem}`);
  log(`Outcome: ${gated}`);
  if (input.GITHUB_OUTPUT) appendFileSync(input.GITHUB_OUTPUT, `outcome=${gated}
`);
  return gateExitCode(gated, input.FAIL_ON);
}
main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`::error::${error.stack ?? String(error)}`);
    process.exit(1);
  }
);
