import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
import {
  FileReviewPolicy,
  GatherInputSchema,
  GitHubClient,
  commenterAuthority,
  describePolicy,
  isHuman,
  loadSnapshot,
  parseDecisionOwners,
  quotableJson,
  recoverState,
  reviewerSchema
} from "./chunks/chunk-5SQOZLDW.mjs";

// src/gather.ts
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
function output(file, name, value) {
  const delimiter = `EOF_${Math.random().toString(36).slice(2)}`;
  appendFileSync(file, `${name}<<${delimiter}
${value}
${delimiter}
`);
}
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 2e8 }).trim();
}
function hasCommit(cwd, sha) {
  try {
    git(cwd, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}
function skipReason(snapshot, repo, skipLabel, expectedHead) {
  const pull = snapshot.pull;
  if (pull.state !== "open") return `PR #${pull.number} is not open`;
  if (pull.draft) return `PR #${pull.number} is a draft`;
  if (pull.head.repo?.full_name !== repo) return `PR #${pull.number} comes from a fork`;
  if (skipLabel !== "" && pull.labels.some((label) => label.name === skipLabel))
    return `PR #${pull.number} has the \`${skipLabel}\` label`;
  if (expectedHead !== "" && expectedHead !== pull.head.sha)
    return `stale event: it ran for ${expectedHead.slice(0, 7)} but the PR head is ${pull.head.sha.slice(0, 7)}`;
  return "";
}
async function main() {
  const input = GatherInputSchema.parse(process.env);
  const repo = input.GITHUB_REPOSITORY;
  const client = new GitHubClient({ token: input.GH_TOKEN, apiUrl: input.GITHUB_API_URL, graphqlUrl: input.GITHUB_GRAPHQL_URL });
  const contextDir = join(input.OUT_DIR, "context");
  mkdirSync(contextDir, { recursive: true });
  if (input.EVENT_NAME === "issue_comment") {
    const { permission } = await client.get(
      `/repos/${repo}/collaborators/${encodeURIComponent(input.SENDER_LOGIN)}/permission`
    );
    if (!["admin", "maintain", "write"].includes(permission))
      throw new Error(`@${input.SENDER_LOGIN} lacks write access (${permission}); refusing a manual review`);
  }
  const bot = await client.get(`/users/${encodeURIComponent(`${input.APP_SLUG}[bot]`)}`);
  const snapshot = await loadSnapshot(client, repo, input.PR_NUMBER);
  const pull = snapshot.pull;
  const headSha = pull.head.sha;
  const policy = {
    owners: parseDecisionOwners(input.DECISION_OWNERS),
    requireMapping: input.REQUIRE_DECISION_MAPPING
  };
  const recovered = recoverState(snapshot, [bot.id]);
  const summary = snapshot.issueComments.find((comment) => comment.id === recovered.summaryCommentId);
  const state = {
    prNumber: pull.number,
    headSha,
    botId: bot.id,
    run: false,
    skipReason: skipReason(snapshot, repo, input.SKIP_LABEL, input.EXPECTED_HEAD_SHA),
    incompleteReason: "",
    trustedRef: "",
    charters: [],
    tierA: [],
    policy,
    recovered,
    summaryUrl: summary?.html_url ?? pull.html_url
  };
  const finish = () => {
    writeFileSync(join(input.OUT_DIR, "gather-state.json"), JSON.stringify(state, null, 2));
    output(input.GITHUB_OUTPUT, "run", String(state.run));
    output(input.GITHUB_OUTPUT, "skip", String(state.skipReason !== ""));
    output(input.GITHUB_OUTPUT, "head_sha", headSha);
    output(input.GITHUB_OUTPUT, "context_dir", contextDir);
  };
  if (state.skipReason !== "") {
    console.log(`Skipping review: ${state.skipReason}`);
    return finish();
  }
  const changedLines = pull.additions + pull.deletions;
  if (snapshot.files.length !== pull.changed_files) {
    state.incompleteReason = `GitHub listed ${snapshot.files.length} of the PR's ${pull.changed_files} changed files (the file list caps at 3000); split the PR`;
    return finish();
  }
  if (changedLines > input.MAX_CHANGED_LINES) {
    state.incompleteReason = `the PR changes ${changedLines} lines, above the ${input.MAX_CHANGED_LINES}-line review limit; split it into smaller PRs`;
    return finish();
  }
  const cwd = input.WORKSPACE;
  if (git(cwd, ["rev-parse", "HEAD"]) !== headSha) throw new Error(`workspace is not checked out at the PR head ${headSha}`);
  const defaultBranch = pull.base.repo.default_branch;
  const trusted = await client.get(`/repos/${repo}/branches/${encodeURIComponent(defaultBranch)}`);
  state.trustedRef = trusted.commit.sha;
  for (const sha of [state.trustedRef, pull.base.sha])
    if (!hasCommit(cwd, sha)) throw new Error(`commit ${sha} is missing from the checkout; check out with fetch-depth: 0`);
  const mergeBase = git(cwd, ["merge-base", pull.base.sha, headSha]);
  writeFileSync(join(contextDir, "diff.patch"), git(cwd, ["diff", "--no-color", "--find-renames", mergeBase, headSha]) + "\n");
  writeFileSync(
    join(contextDir, "history.txt"),
    [
      `# Commits in this PR (${mergeBase.slice(0, 12)}..${headSha.slice(0, 12)})`,
      git(cwd, ["log", "--no-color", "--stat", "--format=commit %H%nAuthor: %an%nDate: %ad%n%n%B", `${mergeBase}..${headSha}`]),
      "",
      "# Recent history of each changed file before this PR",
      ...snapshot.files.filter((file) => file.status !== "added").slice(0, 200).map((file) => {
        const path = file.previous_filename ?? file.filename;
        let log = "";
        try {
          log = git(cwd, ["log", "--no-color", "-n", "5", "--format=%h %ad %s", "--date=short", mergeBase, "--", path]);
        } catch {
          log = "(no history)";
        }
        return `## ${path}
${log || "(no history)"}`;
      })
    ].join("\n") + "\n"
  );
  const loaded = new FileReviewPolicy({ home: join(input.KIT_HOME, "flight-rules") }).load({
    paths: snapshot.files.map((file) => file.filename)
  });
  state.charters = loaded.charters.map((charter) => charter.id);
  state.tierA = loaded.tierA;
  const rules = new FileReviewPolicy({ home: join(input.KIT_HOME, "flight-rules") }).repository({
    cwd,
    trustedRef: state.trustedRef,
    contextPath: input.CONTEXT_PATH
  });
  writeFileSync(join(contextDir, "method.md"), loaded.method);
  writeFileSync(join(contextDir, "contract.md"), loaded.contract);
  writeFileSync(join(contextDir, "charters.md"), loaded.charter);
  writeFileSync(
    join(contextDir, "tier-a.json"),
    JSON.stringify(
      loaded.charters.map((charter) => ({ charter: charter.id, language: charter.language, appliesTo: charter.appliesTo, tierA: charter.tierA })),
      null,
      2
    )
  );
  writeFileSync(
    join(contextDir, "repo-rules.md"),
    [
      `# Repository rules at trusted commit ${state.trustedRef} (${defaultBranch})`,
      "",
      rules.missing.length > 0 ? `Missing: ${rules.missing.join(", ")}` : "Missing: none",
      ...rules.sources.map((source) => `
## ${source.path}

${source.contents}`)
    ].join("\n")
  );
  const users = [
    ...snapshot.issueComments.map((comment) => comment.user),
    ...snapshot.reviewComments.map((comment) => comment.user),
    ...snapshot.reviews.map((review) => review.user)
  ].filter((user) => user !== null);
  const authority = await commenterAuthority(client, repo, policy, pull.user.id, users);
  const who = new Map(authority.map((entry) => [entry.id, entry]));
  const person = (user) => user === null ? null : who.get(user.id) ?? { login: user.login, id: user.id, human: isHuman(user), decides: false, basis: "unknown" };
  const lastSha = recovered.state?.sha;
  let commitsSince = "first review of this PR";
  if (lastSha !== void 0 && lastSha !== headSha) {
    try {
      const compare = await client.get(
        `/repos/${repo}/compare/${lastSha}...${headSha}`
      );
      commitsSince = compare.status === "ahead" ? compare.commits.map((commit) => ({ sha: commit.sha, message: commit.commit.message.split("\n")[0] })) : `history was rewritten since ${lastSha} (compare status ${compare.status})`;
    } catch {
      commitsSince = `history was rewritten since ${lastSha}; that commit is no longer reachable`;
    }
  } else if (lastSha === headSha) commitsSince = "no new commits since the last reviewed head";
  const priorFindings = recovered.records.map((entry) => {
    const location = entry.location;
    const thread = location.kind === "review_comment" ? snapshot.threads.find((candidate) => candidate.rootCommentId === location.comment_id) : void 0;
    const replies = location.kind === "review_comment" ? snapshot.reviewComments.filter((comment) => comment.in_reply_to_id === location.comment_id).map((comment) => ({
      comment_id: comment.id,
      url: comment.html_url,
      created_at: comment.created_at,
      author: person(comment.user),
      body: comment.body
    })) : "body finding: replies are in conversation.json";
    return {
      id: entry.record.finding.id,
      status: entry.record.status,
      record: entry.record,
      artifact: { ...location, url: entry.url },
      thread: thread && { thread_id: thread.id, resolved: thread.isResolved, resolved_by: thread.resolvedBy },
      replies
    };
  });
  writeFileSync(
    join(contextDir, "prior-findings.json"),
    JSON.stringify(
      { last_reviewed_sha: lastSha ?? null, commits_since: commitsSince, recovery_notes: recovered.notes, records: priorFindings },
      null,
      2
    )
  );
  writeFileSync(
    join(contextDir, "conversation.json"),
    JSON.stringify(
      {
        issue_comments: snapshot.issueComments.filter((comment) => comment.id !== recovered.summaryCommentId).map((comment) => ({ comment_id: comment.id, url: comment.html_url, created_at: comment.created_at, author: person(comment.user), body: comment.body })),
        reviews: snapshot.reviews.filter((review) => review.user?.id !== bot.id && review.body).map((review) => ({ review_id: review.id, state: review.state, url: review.html_url, author: person(review.user), body: review.body }))
      },
      null,
      2
    )
  );
  writeFileSync(
    join(contextDir, "pull-request.json"),
    JSON.stringify(
      {
        repository: repo,
        number: pull.number,
        url: pull.html_url,
        title: pull.title,
        body: pull.body,
        author: { login: pull.user.login, id: pull.user.id },
        head: { ref: pull.head.ref, sha: headSha },
        base: { ref: pull.base.ref, sha: pull.base.sha, merge_base: mergeBase, default_branch: defaultBranch },
        stacked: pull.base.ref !== defaultBranch,
        changed_lines: changedLines,
        files: snapshot.files.map(({ filename, status, additions, deletions, previous_filename }) => ({
          filename,
          status,
          additions,
          deletions,
          ...previous_filename ? { previous_filename } : {}
        }))
      },
      null,
      2
    )
  );
  writeFileSync(
    join(contextDir, "authority.md"),
    `${describePolicy(policy, pull.user.login)}

Commenters:
${authority.map((entry) => `- @${entry.login} (id ${entry.id}): ${entry.human ? "human" : "bot"}, ${entry.decides ? "can decide" : "cannot decide"} (${entry.basis})`).join("\n")}
`
  );
  const prompt = readFileSync(join(input.KIT_HOME, "prompts", "reviewer.md"), "utf8").replaceAll("{{PR_NUMBER}}", String(pull.number)).replaceAll("{{REPOSITORY}}", repo).replaceAll("{{CONTEXT_DIR}}", contextDir).replaceAll("{{TRUSTED_REF}}", state.trustedRef).replaceAll("{{HEAD_SHA}}", headSha);
  state.run = true;
  output(input.GITHUB_OUTPUT, "prompt", prompt);
  output(input.GITHUB_OUTPUT, "schema", quotableJson(reviewerSchema(input.KIT_HOME)));
  finish();
}
main().catch((error) => {
  console.error(`::error::${error.message}`);
  process.exit(1);
});
