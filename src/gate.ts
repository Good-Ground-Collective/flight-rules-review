import type { ReviewOutcome } from "@good-ground-collective/flight-rules/review";
import type { FailOn } from "./inputs.js";

/** Exit status for the review job, which a ruleset can require as a status check. */
export function gateExitCode(outcome: ReviewOutcome, failOn: FailOn): number {
  if (failOn === "never") return 0;
  if (failOn === "incomplete") return outcome === "INCOMPLETE" ? 1 : 0;
  if (outcome !== "APPROVED") {
    console.log(`::error::flight-rules review outcome is ${outcome}`);
    return 1;
  }
  return 0;
}
