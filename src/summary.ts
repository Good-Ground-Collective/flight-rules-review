import { JsonReviewCodec } from "@good-ground-collective/flight-rules/review";
import type { FindingRecord, ReviewOutcome, ReviewState, StoredFinding } from "@good-ground-collective/flight-rules/review";
import { SUMMARY_MARKER, type ActionableEntry, type InformationalEntry, type RecordLocation } from "./recover.js";
import type { FlightRulesExtension } from "./strict.js";

export const SUMMARY_BUDGET = 60_000;

export interface PublishedRecord {
  record: FindingRecord;
  location: RecordLocation;
  url: string;
}
export interface Transition {
  id: string;
  from: FindingRecord["status"];
  to: FindingRecord["status"];
  updated: boolean;
  reason: string;
}
export interface SummaryInput {
  outcome: ReviewOutcome;
  headSha: string;
  reviewSummary?: string;
  outcomeReason?: string;
  remainingRisk?: string;
  problems: string[];
  notes: string[];
  records: PublishedRecord[];
  informational: InformationalEntry[];
  /** Index entries whose records could not be recovered; kept in the state as they were. */
  unrecovered?: ActionableEntry[];
  transitions: Transition[];
  coverage?: FlightRulesExtension;
  trustedRef?: string;
  runUrl?: string;
  model?: string;
}

const OUTCOME_ALERT: Record<ReviewOutcome, { kind: string; title: string; fallback: string }> = {
  APPROVED: { kind: "TIP", title: "Approved", fallback: "Nothing blocking is open." },
  CHANGES_NEEDED: { kind: "CAUTION", title: "Changes needed", fallback: "Blocking fixes or questions are open." },
  ESCALATE: { kind: "IMPORTANT", title: "Escalated: a human decision is needed", fallback: "A blocking decision is open." },
  INCOMPLETE: { kind: "WARNING", title: "Incomplete", fallback: "The review did not complete." },
};

function link(entry: PublishedRecord): string {
  return `[\`${entry.record.finding.id}\`](${entry.url})`;
}

function line(entry: PublishedRecord): string {
  const finding = entry.record.finding;
  const where = finding.path === "" ? "PR-wide" : `\`${finding.path}${finding.line > 0 ? `:${finding.line}` : ""}\``;
  return `| ${link(entry)} | ${finding.label} · ${finding.severity} | ${escapeCell(finding.subject)} | ${where} |`;
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function table(entries: PublishedRecord[]): string {
  return ["| Finding | Label | Subject | Where |", "| --- | --- | --- | --- |", ...entries.map(line)].join("\n");
}

function fold(title: string, body: string): string {
  return `<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>`;
}

/** The portable state index (contract §6.1). */
export function stateIndex(input: {
  headSha: string;
  outcome: ReviewOutcome;
  records: PublishedRecord[];
  informational: InformationalEntry[];
  unrecovered?: ActionableEntry[];
}): ReviewState {
  return {
    v: 1,
    schema_revision: 1,
    sha: input.headSha,
    outcome: input.outcome,
    records: [
      ...input.records.map((entry) => ({ id: entry.record.finding.id, status: entry.record.status, location: entry.location })),
      ...(input.unrecovered ?? []).filter((entry) => !input.records.some((rec) => rec.record.finding.id === entry.id)),
      ...input.informational,
    ],
  };
}

export function informationalEntries(previous: InformationalEntry[], added: StoredFinding[]): InformationalEntry[] {
  const codec = new JsonReviewCodec();
  const seen = new Set(previous.map((entry) => entry.fingerprint));
  const entries = [...previous];
  for (const finding of added) {
    const fingerprint = codec.fingerprint(finding);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    entries.push({ id: finding.id, status: "informational", fingerprint, finding: finding as InformationalEntry["finding"] });
  }
  return entries;
}

/** Renders the single summary comment in the contract §6.1 order, shortening derived sections first. */
export function renderSummary(input: SummaryInput): string {
  const codec = new JsonReviewCodec();
  const open = input.records.filter((entry) => entry.record.status === "open");
  const blocking = open.filter((entry) => entry.record.finding.blocking);
  const decisions = blocking.filter((entry) => entry.record.finding.type === "decide");
  const fixes = blocking.filter((entry) => entry.record.finding.type === "fix");
  const questions = blocking.filter((entry) => entry.record.finding.type === "clarify");
  const optional = open.filter((entry) => !entry.record.finding.blocking);
  const alert = OUTCOME_ALERT[input.outcome];

  const reason =
    input.outcome === "INCOMPLETE"
      ? `${input.problems.length > 0 ? input.problems.map((problem) => `- ${problem}`).join("\n> ") : alert.fallback}\n>\n> Re-run the review workflow after fixing the cause. Open findings below still stand.`
      : (input.outcomeReason ?? alert.fallback);

  const head = [
    SUMMARY_MARKER,
    "## flight-rules review",
    "",
    `> [!${alert.kind}]\n> **${alert.title}.** ${input.outcome === "INCOMPLETE" ? "\n> " : ""}${reason}`,
    "",
    `Reviewed \`${input.headSha.slice(0, 7)}\` in strict comprehensive mode · ${blocking.length} blocking · ${optional.length} optional${input.model ? ` · ${input.model}` : ""}${input.runUrl ? ` · [run](${input.runUrl})` : ""}`,
  ];
  if (input.reviewSummary) head.push("", input.reviewSummary);

  const sections: string[] = [];
  if (decisions.length > 0)
    sections.push(
      "### Decisions needed",
      "",
      ...decisions.map((entry) => {
        const finding = entry.record.finding;
        return `- ${link(entry)} ${finding.subject}: owner **${finding.type === "decide" ? finding.decision_owner : ""}**`;
      }),
    );
  if (fixes.length > 0) sections.push(...(sections.length > 0 ? [""] : []), "### Required fixes", "", table(fixes));
  if (questions.length > 0) sections.push(...(sections.length > 0 ? [""] : []), "### Open questions", "", table(questions));

  const optionalSection: string[] = [];
  if (optional.length > 0) {
    const counts = new Map<string, number>();
    for (const entry of optional) counts.set(entry.record.finding.label, (counts.get(entry.record.finding.label) ?? 0) + 1);
    optionalSection.push(
      "### Optional improvements",
      "",
      [...counts].map(([label, count]) => `${count} ${label}`).join(" · "),
      "",
      fold("Show optional findings", table(optional)),
    );
  }
  const progress: string[] = [];
  if (input.transitions.length > 0)
    progress.push(
      "### Progress since the last pass",
      "",
      ...input.transitions.map(
        (transition) =>
          `- \`${transition.id}\` ${transition.updated && transition.from === transition.to ? "updated" : `${transition.from} → ${transition.to}`}: ${transition.reason}`,
      ),
    );
  const risk = input.remainingRisk ? ["### Remaining risk", "", input.remainingRisk] : [];
  const notes =
    input.notes.length > 0 ? [fold("Reconciliation notes", input.notes.map((note) => `- ${note}`).join("\n"))] : [];
  const coverage = input.coverage
    ? [
        fold(
          `Charter coverage: ${input.coverage.charterCoverage.charters.join(", ")} · Tier A ${input.coverage.counts.tierA} · Tier B ${input.coverage.counts.tierB} · holistic ${input.coverage.counts.holistic}`,
          [
            `Lint: ${input.coverage.lint.status}. ${input.coverage.lint.detail}`,
            input.trustedRef ? `Repository rules read from \`${input.trustedRef.slice(0, 12)}\`.` : "",
            "",
            "| Mandate | Charter | State | Files |",
            "| --- | --- | --- | --- |",
            ...input.coverage.charterCoverage.mandates.map(
              (mandate) =>
                `| ${mandate.id} | ${mandate.charter} | ${mandate.state} | ${mandate.files.length > 0 ? escapeCell(mandate.files.join(", ")) : "none"} |`,
            ),
          ].join("\n"),
        ),
      ]
    : [];
  const informational = input.informational.filter((entry) => entry.finding !== undefined);
  const notesSection =
    informational.length > 0
      ? [
          fold(
            `Notes and praise (${informational.length})`,
            informational
              .map((entry) => `- **${entry.finding!.label}:** ${entry.finding!.subject}${entry.finding!.path ? ` (\`${entry.finding!.path}\`)` : ""}`)
              .join("\n"),
          ),
        ]
      : [];

  const markerFor = (entries: InformationalEntry[]): string =>
    codec.state(
      stateIndex({ headSha: input.headSha, outcome: input.outcome, records: input.records, informational: entries, unrecovered: input.unrecovered }),
    );
  const compose = (parts: string[][], marker: string): string =>
    [head.join("\n"), ...parts.filter((part) => part.length > 0).map((part) => part.join("\n")), marker].join("\n\n");

  const marker = markerFor(input.informational);
  const ladder: string[][][] = [
    [sections, optionalSection, progress, risk, notesSection, coverage, notes],
    [sections, optionalSection.slice(0, 2), progress, risk, coverage],
    [sections, optionalSection.slice(0, 2), risk],
    [sections.slice(0, 1), risk],
    [],
  ];
  for (const parts of ladder) {
    const body = compose(parts, marker);
    if (body.length <= SUMMARY_BUDGET) return body;
  }
  // Older informational entries may shrink to their id and fingerprint (contract §6.1).
  const compact = input.informational.map(({ id, status, fingerprint }) => ({ id, status, fingerprint }));
  return compose([], markerFor(compact));
}
