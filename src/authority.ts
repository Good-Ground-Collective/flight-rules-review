import { GitHubReviewVerifier } from "@good-ground-collective/flight-rules/review";
import type {
  ActionableFinding,
  DecisionAnswer,
  ReviewEvidence,
  ReviewVerifier,
} from "@good-ground-collective/flight-rules/review";
import type { GitHubClient } from "./github.js";
import type { GitHubUser } from "./pull-request.js";

export interface AuthorityPolicy {
  /** Exact `decision_owner` role → logins; `*` applies to every role without its own entry. */
  owners: Record<string, string[]>;
  requireMapping: boolean;
}

export interface CommenterAuthority {
  login: string;
  id: number;
  human: boolean;
  decides: boolean;
  basis: string;
}

/** Decision owners the policy maps explicitly; a `*` entry lets those logins answer any role. */
export function ownersFor(policy: AuthorityPolicy, role: string): string[] | undefined {
  return policy.owners[role] ?? policy.owners["*"];
}

export function describePolicy(policy: AuthorityPolicy, prAuthor: string): string {
  const roles = Object.entries(policy.owners).map(
    ([role, logins]) => `- ${role === "*" ? "any decision owner" : `\`${role}\``}: ${logins.map((l) => `@${l}`).join(", ")}`,
  );
  const fallback = policy.requireMapping
    ? "No fallback: a decision whose owner has no mapping stays open."
    : `Fallback (independent sign-off, not proof of policy ownership): a human with write, maintain or admin access who is not the PR author (@${prAuthor}).`;
  return [
    "Decision authority (trusted action configuration, never PR content):",
    ...(roles.length > 0 ? roles : ["- no explicit owner mapping"]),
    fallback,
    "Bots never supply authorization.",
  ].join("\n");
}

/** Resolves who among the PR's commenters can answer a decision, for the reviewer's context. */
export async function commenterAuthority(
  client: GitHubClient,
  repo: string,
  policy: AuthorityPolicy,
  prAuthorId: number,
  users: GitHubUser[],
): Promise<CommenterAuthority[]> {
  const mapped = new Set(Object.values(policy.owners).flat().map((login) => login.toLowerCase()));
  const unique = [...new Map(users.map((user) => [user.id, user])).values()];
  return Promise.all(
    unique.map(async (user): Promise<CommenterAuthority> => {
      const human = user.type === "User";
      const base = { login: user.login, id: user.id, human };
      if (!human) return { ...base, decides: false, basis: "bot or app account" };
      if (mapped.has(user.login.toLowerCase()))
        return { ...base, decides: true, basis: "explicit decision-owner mapping (only for the roles it maps)" };
      if (policy.requireMapping) return { ...base, decides: false, basis: "not in the required owner mapping" };
      if (user.id === prAuthorId) return { ...base, decides: false, basis: "PR author" };
      try {
        const { permission } = await client.get<{ permission: string }>(
          `/repos/${repo}/collaborators/${encodeURIComponent(user.login)}/permission`,
        );
        const writer = ["admin", "maintain", "write"].includes(permission);
        return {
          ...base,
          decides: writer,
          basis: writer ? `independent repository ${permission} access (fallback)` : `repository ${permission} access`,
        };
      } catch {
        return { ...base, decides: false, basis: "repository permission could not be read" };
      }
    }),
  );
}

/**
 * Delegates evidence checks to flight-rules' GitHubReviewVerifier and adds the `*` owner wildcard by
 * handing it an exact-role mapping for the finding being decided.
 */
export class ActionReviewVerifier implements ReviewVerifier {
  private readonly base: ConstructorParameters<typeof GitHubReviewVerifier>[0];
  private readonly policy: AuthorityPolicy;
  private readonly inner: GitHubReviewVerifier;

  constructor(props: { client: GitHubClient; repo: string; prNumber: number; prAuthorId: number; policy: AuthorityPolicy }) {
    this.policy = props.policy;
    this.base = {
      repo: props.repo,
      prNumber: props.prNumber,
      prAuthorId: props.prAuthorId,
      requireMapping: props.policy.requireMapping,
      api: {
        get: (path: string) => props.client.get(path),
        // GitHubReviewVerifier reads the raw GraphQL envelope (`result.data`).
        graphql: async (query: string, variables: Record<string, string | number>) => ({
          data: await props.client.graphql(query, variables),
        }),
      },
    };
    this.inner = new GitHubReviewVerifier({ ...this.base, owners: {} });
  }

  verify(evidence: ReviewEvidence, headSha: string): Promise<boolean> {
    return this.inner.verify(evidence, headSha);
  }

  dismissal(evidence: ReviewEvidence): Promise<boolean> {
    return this.inner.dismissal(evidence);
  }

  authorize(answer: DecisionAnswer, finding: ActionableFinding): Promise<boolean> {
    if (finding.type !== "decide") return this.inner.authorize(answer, finding);
    const owners = ownersFor(this.policy, finding.decision_owner);
    const verifier = new GitHubReviewVerifier({
      ...this.base,
      owners: owners === undefined ? {} : { [finding.decision_owner]: owners },
    });
    return verifier.authorize(answer, finding);
  }
}
