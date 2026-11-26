import { existsSync, readFileSync } from "node:fs";

export type ExecutionResult = { ok: true; output: unknown } | { ok: false; reason: string };

/** Reads the structured output from Claude Code's execution transcript (a JSON array of messages). */
export function readStructuredOutput(file: string): ExecutionResult {
  if (file === "" || !existsSync(file)) return { ok: false, reason: "the reviewer produced no execution transcript" };
  let messages: unknown;
  try {
    messages = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, reason: "the reviewer transcript is not valid JSON" };
  }
  if (!Array.isArray(messages)) return { ok: false, reason: "the reviewer transcript is not a message list" };
  const result = [...messages].reverse().find(
    (message): message is { type: "result"; subtype?: string; is_error?: boolean; structured_output?: unknown } =>
      typeof message === "object" && message !== null && (message as { type?: unknown }).type === "result",
  );
  if (result === undefined) return { ok: false, reason: "the reviewer did not finish (no result message)" };
  if (result.is_error || (result.subtype && result.subtype !== "success"))
    return { ok: false, reason: `the reviewer ended with ${result.subtype ?? "an error"}` };
  if (result.structured_output === undefined || result.structured_output === null)
    return { ok: false, reason: "the reviewer returned no structured review" };
  return { ok: true, output: result.structured_output };
}
