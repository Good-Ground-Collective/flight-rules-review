import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Strict mode: every pass is comprehensive, and a pass only counts when it accounts for every Tier A
 * mandate of every applicable charter. This action runs no PR-head linter, so `enforced` is never a
 * valid coverage state; mandates are `reviewed` by hand or `waived` by trusted repo configuration.
 */
export const MandateCoverageSchema = z.strictObject({
  id: z.string().min(1),
  charter: z.string().min(1),
  state: z.enum(["reviewed", "waived", "not_applicable"]),
  files: z.array(z.string()),
  note: z.string().max(2000).optional(),
});

export const FlightRulesExtensionSchema = z.strictObject({
  charterCoverage: z.strictObject({
    charters: z.array(z.string().min(1)).min(1),
    mandates: z.array(MandateCoverageSchema),
  }),
  lint: z.strictObject({
    status: z.literal("absent"),
    detail: z.string().min(1).max(2000),
  }),
  counts: z.strictObject({
    tierA: z.number().int().min(0),
    tierB: z.number().int().min(0),
    holistic: z.number().int().min(0),
  }),
});
export type FlightRulesExtension = z.infer<typeof FlightRulesExtensionSchema>;

export interface StrictCheckInput {
  review: { review_complete: boolean; incomplete_reason?: string; extensions?: Record<string, unknown> };
  tierA: string[];
  charters: string[];
}

/** Problems that make a pass INCOMPLETE under strict mode. */
export function strictProblems(input: StrictCheckInput): string[] {
  const problems: string[] = [];
  if (!input.review.review_complete)
    problems.push(`the reviewer reported an incomplete review: ${input.review.incomplete_reason || "no reason given"}`);
  const parsed = FlightRulesExtensionSchema.safeParse(input.review.extensions?.flight_rules);
  if (!parsed.success) {
    problems.push(`extensions.flight_rules is missing or invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    return problems;
  }
  const coverage = parsed.data.charterCoverage;
  const missingCharters = input.charters.filter((id) => !coverage.charters.includes(id));
  if (missingCharters.length > 0) problems.push(`charter coverage omits ${missingCharters.join(", ")}`);
  const accounted = new Set(coverage.mandates.map((mandate) => mandate.id));
  const missing = input.tierA.filter((id) => !accounted.has(id));
  if (missing.length > 0) problems.push(`Tier A coverage omits ${missing.join(", ")}`);
  return problems;
}

/**
 * The model-facing schema: flight-rules' transport schema with `extensions.flight_rules` required in
 * the strict shape above. Kept draft-07 because Claude Code validates structured output with Ajv.
 */
export function reviewerSchema(kitHome: string): Record<string, unknown> {
  const transport = JSON.parse(
    readFileSync(join(kitHome, "flight-rules", "contracts", "code-review", "review.v1.transport.schema.json"), "utf8"),
  ) as { properties: Record<string, unknown>; required: string[] };
  const extension = z.toJSONSchema(FlightRulesExtensionSchema, { target: "draft-07" }) as Record<string, unknown>;
  delete extension.$schema;
  return {
    ...transport,
    properties: {
      ...transport.properties,
      extensions: {
        type: "object",
        properties: { flight_rules: extension },
        required: ["flight_rules"],
        additionalProperties: false,
      },
    },
    required: [...new Set([...transport.required, "extensions"])],
  };
}

/** JSON text safe inside a single-quoted shell-style argument: apostrophes become JSON escapes. */
export function quotableJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("'", "\\u0027");
}
