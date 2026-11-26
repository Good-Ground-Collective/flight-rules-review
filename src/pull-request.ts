import type { GitHubClient } from "./github.js";

export interface GitHubUser {
  id: number;
  login: string;
  type: string;
}
export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}
export interface IssueComment {
  id: number;
  body: string | null;
  user: GitHubUser | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}
export interface ReviewComment extends IssueComment {
  path: string;
  line: number | null;
  in_reply_to_id?: number;
  pull_request_review_id: number | null;
}
export interface Review {
  id: number;
  body: string | null;
  user: GitHubUser | null;
  state: string;
  html_url: string;
  commit_id: string | null;
  submitted_at?: string;
}
export interface ReviewThread {
  id: string;
  isResolved: boolean;
  resolvedBy: { login: string; databaseId: number | null; type: string } | null;
  rootCommentId: number | null;
}
export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  user: GitHubUser;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string; default_branch: string } };
  labels: { name: string }[];
  html_url: string;
  additions: number;
  deletions: number;
  changed_files: number;
}
export interface PullSnapshot {
  pull: PullRequest;
  files: PullFile[];
  issueComments: IssueComment[];
  reviewComments: ReviewComment[];
  reviews: Review[];
  threads: ReviewThread[];
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){
    pageInfo{hasNextPage endCursor}
    nodes{id isResolved resolvedBy{login databaseId __typename}
      comments(first:1){nodes{databaseId}}}}}}}`;

interface ThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          isResolved: boolean;
          resolvedBy: { login: string; databaseId: number | null; __typename: string } | null;
          comments: { nodes: { databaseId: number | null }[] };
        }[];
      };
    };
  };
}

export async function loadPull(client: GitHubClient, repo: string, number: number): Promise<PullRequest> {
  return client.get<PullRequest>(`/repos/${repo}/pulls/${number}`);
}

export async function loadSnapshot(client: GitHubClient, repo: string, number: number): Promise<PullSnapshot> {
  const [owner, name] = repo.split("/") as [string, string];
  const [pull, files, issueComments, reviewComments, reviews] = await Promise.all([
    loadPull(client, repo, number),
    client.paginate<PullFile>(`/repos/${repo}/pulls/${number}/files`),
    client.paginate<IssueComment>(`/repos/${repo}/issues/${number}/comments`),
    client.paginate<ReviewComment>(`/repos/${repo}/pulls/${number}/comments`),
    client.paginate<Review>(`/repos/${repo}/pulls/${number}/reviews`),
  ]);
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  do {
    const page: ThreadsPage = await client.graphql<ThreadsPage>(THREADS_QUERY, { owner, name, number, cursor });
    const connection = page.repository.pullRequest.reviewThreads;
    for (const node of connection.nodes)
      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        resolvedBy: node.resolvedBy && {
          login: node.resolvedBy.login,
          databaseId: node.resolvedBy.databaseId,
          type: node.resolvedBy.__typename,
        },
        rootCommentId: node.comments.nodes[0]?.databaseId ?? null,
      });
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor !== null);
  return { pull, files, issueComments, reviewComments, reviews, threads };
}

export function isHuman(user: GitHubUser | null): boolean {
  return user !== null && user.type === "User";
}
