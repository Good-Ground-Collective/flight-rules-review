import { z } from "zod";

export const FailOnSchema = z.enum(["not-approved", "incomplete", "never"]);
export type FailOn = z.infer<typeof FailOnSchema>;

const flag = z
  .string()
  .default("false")
  .transform((value) => value.trim().toLowerCase() === "true");

/** Parses `role: [login]` maps (JSON) or a plain login list, which maps every decision owner. */
export function parseDecisionOwners(raw: string): Record<string, string[]> {
  const text = raw.trim();
  if (text === "") return {};
  if (text.startsWith("{")) {
    return z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).parse(JSON.parse(text));
  }
  const logins = text
    .split(/[\s,]+/)
    .map((login) => login.replace(/^@/, "").trim())
    .filter((login) => login !== "");
  return logins.length === 0 ? {} : { "*": logins };
}

const BaseSchema = z.object({
  GITHUB_REPOSITORY: z.string().regex(/^[^/]+\/[^/]+$/),
  GH_TOKEN: z.string().min(1),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  GITHUB_GRAPHQL_URL: z.string().url().default("https://api.github.com/graphql"),
  PR_NUMBER: z.coerce.number().int().positive(),
  APP_SLUG: z.string().min(1),
  KIT_HOME: z.string().min(1),
  OUT_DIR: z.string().min(1),
});

export const GatherInputSchema = BaseSchema.extend({
  WORKSPACE: z.string().min(1),
  CONTEXT_PATH: z.string().min(1).default("CODE-REVIEW.md"),
  DECISION_OWNERS: z.string().default(""),
  REQUIRE_DECISION_MAPPING: flag,
  SKIP_LABEL: z.string().default(""),
  EVENT_NAME: z.string().default(""),
  EXPECTED_HEAD_SHA: z.string().default(""),
  SENDER_LOGIN: z.string().default(""),
  MAX_CHANGED_LINES: z.coerce.number().int().positive().default(20000),
  GITHUB_OUTPUT: z.string().min(1),
});
export type GatherInput = z.infer<typeof GatherInputSchema>;

export const PostInputSchema = BaseSchema.extend({
  REQUEST_CHANGES: flag,
  APPROVE: flag,
  FAIL_ON: FailOnSchema.default("not-approved"),
  EXECUTION_FILE: z.string().default(""),
  CLAUDE_OUTCOME: z.string().default(""),
  DRY_RUN: flag,
  GITHUB_STEP_SUMMARY: z.string().default(""),
  GITHUB_SERVER_URL: z.string().url().default("https://github.com"),
  GITHUB_RUN_ID: z.string().default(""),
  GITHUB_OUTPUT: z.string().default(""),
  MODEL: z.string().default(""),
});
export type PostInput = z.infer<typeof PostInputSchema>;
