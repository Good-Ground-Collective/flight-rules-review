/** Minimal GitHub REST/GraphQL client; every write goes through `write` so dry runs can log instead. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly detail: string,
  ) {
    super(`GitHub ${method} ${path} failed with ${status}: ${detail}`);
    this.name = "GitHubError";
  }
}

export interface GitHubClientProps {
  token: string;
  apiUrl: string;
  graphqlUrl: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export class GitHubClient {
  private readonly props: GitHubClientProps;
  private dryRunId = 9_000_000_000;

  constructor(props: GitHubClientProps) {
    this.props = props;
  }

  get dryRun(): boolean {
    return this.props.dryRun ?? false;
  }

  async get<T = unknown>(path: string, accept = "application/vnd.github+json"): Promise<T> {
    const response = await this.request("GET", path, undefined, accept);
    return (accept.includes("json") ? await response.json() : await response.text()) as T;
  }

  /** Follows `Link: rel="next"` until exhausted. */
  async paginate<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (next !== null) {
      const response = await this.request("GET", next);
      items.push(...((await response.json()) as T[]));
      next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1] ?? null;
    }
    return items;
  }

  async graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.props.graphqlUrl, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify({ query, variables }),
    });
    const payload = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (!response.ok || payload.errors?.length)
      throw new GitHubError(
        response.status,
        "POST",
        "graphql",
        payload.errors?.map((error) => error.message).join("; ") ?? response.statusText,
      );
    return payload.data as T;
  }

  /** A mutating call. In dry-run mode it is logged and answered with a synthetic id. */
  async write<T = unknown>(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    if (this.dryRun) {
      this.props.log?.(`[dry-run] ${method} ${path} ${JSON.stringify(body ?? {}).slice(0, 400)}`);
      return { id: this.dryRunId++, node_id: "dry-run", html_url: "https://github.com/dry-run" } as T;
    }
    const response = await this.request(method, path, body);
    return (response.status === 204 ? {} : await response.json()) as T;
  }

  async writeGraphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T | undefined> {
    if (this.dryRun) {
      this.props.log?.(`[dry-run] graphql ${JSON.stringify(variables)}`);
      return undefined;
    }
    return this.graphql<T>(query, variables);
  }

  private async request(method: string, path: string, body?: unknown, accept?: string): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.props.apiUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method,
        headers: this.headers(accept),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.ok) return response;
      const retryable = response.status >= 500 || response.status === 429;
      if (retryable && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      throw new GitHubError(response.status, method, path, (await response.text()).slice(0, 2000));
    }
  }

  private headers(accept = "application/vnd.github+json"): Record<string, string> {
    return {
      accept,
      authorization: `Bearer ${this.props.token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "flight-rules-review",
    };
  }
}
