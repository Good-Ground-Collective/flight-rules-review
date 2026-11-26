# flight-rules review

A GitHub Action that reviews pull requests with Claude Code against the
[flight-rules](https://github.com/Good-Ground-Collective/flight-rules) review method, charters and findings contract.
It runs only the strictest profile:

- **Always comprehensive.** Every Tier A charter violation is reported as its own blocking inline finding. Every Tier B judgement, holistic concern and optional improvement is reported too, each labelled with its Conventional Comments label, type (`fix`, `clarify`, `decide`), severity and blocking status.
- **Full coverage or INCOMPLETE.** The reviewer must account for every Tier A mandate of every charter that applies to the changed files. No linter runs on PR-head code, so each mandate is checked by reading the code. A gap in coverage, an unreadable state, a rejected evidence reference or a failed write ends the pass INCOMPLETE. It is never treated as a pass.
- **Blocking means blocked.** Blocking findings are submitted as a `REQUEST_CHANGES` review. When nothing blocking is left open, the change request is dismissed. With `approve: true`, it is replaced by an approval instead, but only when every other check on the head has already passed. The step fails on any outcome other than APPROVED, so a ruleset can require it.
- **Evidence-checked memory.** Findings keep stable IDs across pushes. Each pass reconciles earlier findings against new commits and replies. Only a transition backed by evidence the action has checked against GitHub can close a finding. Only an authorized human can answer a `decide`.

Claude authenticates with a **Claude Code OAuth token**. A GitHub App you own posts the review.

## How it works

```
gather (node)          Claude Code (read-only)            post (node)
─────────────          ───────────────────────            ───────────
PR, diff, threads  →   flight-rules method + charters  →  validate full contract
trusted repo rules     + contract + prior records         check evidence & authority (flight-rules planner)
recovered findings     returns one JSON review object     publish findings, replies, summary + state
                       (no GitHub writes, no edits)       REQUEST_CHANGES / dismiss / approve, exit code
```

- **Gather.** Loads the PR, its diff (merge-base to head, so a stacked PR is reviewed only for its own changes), review threads and earlier finding records. Repository rules (`CODE-REVIEW.md`, `AGENTS.md`, `CLAUDE.md`, `CODEOWNERS`) are read from the default branch's commit, never from the PR head.
- **Review.** [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) runs Claude with only Read, Glob and Grep: no shell at all. Git history the reviewer needs (the diff, the PR's commits, recent history of changed files) is precomputed into context files. The flight-rules transport schema is enforced as structured output and extended so `extensions.flight_rules` (charter coverage) is required.
- **Post.** Validates the result with `reviewContract.parse`, then plans transitions with the flight-rules `EvidenceReviewPlanner` and `GitHubReviewVerifier`. It persists records in contract order and computes the outcome. The model's proposed outcome is never trusted on its own.

The flight-rules library and its docs are bundled into `dist/`, so callers need no package-registry access.

## Setup

1. **Create the GitHub App.** It needs these repository permissions and no webhook:

   | Permission | Access |
   | --- | --- |
   | Pull requests | Read and write |
   | Issues | Read and write (the summary is a PR conversation comment) |
   | Contents | Read |
   | Checks, Commit statuses | Read (evidence verification) |
   | Metadata | Read |

   [`docs/github-app-manifest.json`](docs/github-app-manifest.json) has these settings for the manifest flow. Install the App on the repositories it should review.
2. **Generate a Claude OAuth token** with `claude setup-token`.
3. **Add the credentials** to the repository or organization:
   - secret `CLAUDE_CODE_OAUTH_TOKEN`
   - variable `FLIGHT_RULES_REVIEW_APP_ID` (the numeric App ID, passed as `app-id`; or pass the Client ID as `client-id`)
   - secret `FLIGHT_RULES_REVIEW_PRIVATE_KEY`
4. **Add the workflow.** Copy [`examples/flight-rules-review.yml`](examples/flight-rules-review.yml) to `.github/workflows/`. It reviews same-repository PRs on every push, and re-runs when someone with write access comments `/flight-rules-review` (for example, after answering a question or a decision).
5. **Optional: gate merges.** Require the `review` status check in a ruleset.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `claude-code-oauth-token` | required | Claude Code OAuth token. |
| `client-id` (or `app-id`), `app-private-key` | required | The posting GitHub App. `client-id` is preferred; `app-id` still works but is deprecated upstream. |
| `pr-number` | from the event | PR to review. |
| `model` | `claude-opus-5-5` | Reviewer model. |
| `max-turns` | `100` | Reviewer turn budget. |
| `review-context-path` | `CODE-REVIEW.md` | Repository review rules, read from the default branch. |
| `decision-owners` | empty | Who may answer `decide` findings. Either a JSON object mapping roles to logins (`{"security owner":["alice"]}`) or a comma-separated login list for every role. Mapped owners may decide on their own PRs. If empty, any human writer who is not the PR author can decide. |
| `require-decision-mapping` | `false` | Keep decisions open unless their owner role is mapped. |
| `request-changes` | `true` | Submit blocking findings as `REQUEST_CHANGES` and dismiss that review once nothing blocking is left. |
| `approve` | `false` | Approve, instead of only dismissing, when nothing blocking is left and every other check and status on the head has passed. While CI is pending or failing, the review only dismisses. |
| `fail-on` | `not-approved` | `not-approved`, `incomplete` or `never`. |
| `skip-label` | `skip-review` | PRs with this label are skipped. |
| `max-changed-lines` | `20000` | Larger PRs end INCOMPLETE without a model run. |
| `dry-run` | `false` | Log GitHub writes instead of making them. |

Output: `outcome` is `APPROVED`, `CHANGES_NEEDED`, `ESCALATE` or `INCOMPLETE`, or empty when the PR was skipped.

## Outcomes

| Outcome | When | Review state | Step |
| --- | --- | --- | --- |
| `APPROVED` | Nothing blocking is open | Change request dismissed (or approved) | passes |
| `CHANGES_NEEDED` | A blocking `fix` or `clarify` is open | `REQUEST_CHANGES` | fails |
| `ESCALATE` | A blocking `decide` is open | `REQUEST_CHANGES` | fails |
| `INCOMPLETE` | The review, recovery, evidence check or publication did not finish | Left as it was | fails |

## Security

- Runs only on same-repository PRs. Fork PRs are skipped, and the manual command requires write access.
- The reviewer has no shell, no write tools and no network fetch. PR content is treated as data.
- A summary whose state can't be read is never overwritten. An indexed finding whose marker is lost carries forward in the state, and every pass stays INCOMPLETE until it is repaired.
- PRs above GitHub's 3,000-file listing limit end INCOMPLETE rather than being reviewed partially.
- Earlier finding markers are trusted only when the App authored them.
- Pin the action to a release tag or commit SHA.

## Development

```bash
npm ci          # needs NODE_AUTH_TOKEN with read:packages for @good-ground-collective/flight-rules
npm run check   # typecheck, tests, build, and verify dist/ is committed
```

`dist/` is committed because composite actions run it directly. Rebuild after every source change.

## License

MIT
