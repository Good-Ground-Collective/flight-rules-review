import type { PullFile } from "./pull-request.js";

/** Right-side line numbers GitHub accepts for an inline comment, one ordered list of lines per hunk. */
export interface FileHunks {
  hunks: number[][];
}

export function commentableLines(patch: string | undefined): FileHunks {
  const hunks: number[][] = [];
  if (patch === undefined) return { hunks };
  let current: number[] | null = null;
  let right = 0;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      current = [];
      hunks.push(current);
      right = Number(header[1]);
      continue;
    }
    if (current === null || line.startsWith("\\")) continue;
    if (line.startsWith("-")) continue;
    current.push(right);
    right++;
  }
  return { hunks };
}

export type Placement =
  | { kind: "inline"; path: string; line: number; startLine?: number }
  | { kind: "file"; path: string }
  | { kind: "body" };

/** Contract §4.4: inline inside a diff hunk, else file-level for a changed file, else the review body. */
export function place(
  finding: { path: string; line: number; start_line?: number },
  files: Map<string, FileHunks>,
): Placement {
  const file = files.get(finding.path);
  if (finding.path === "" || file === undefined) return { kind: "body" };
  if (finding.line > 0) {
    const hunk = file.hunks.find((lines) => lines.includes(finding.line));
    if (hunk !== undefined) {
      const start = finding.start_line;
      if (start !== undefined && start > 0 && start < finding.line && hunk.includes(start))
        return { kind: "inline", path: finding.path, line: finding.line, startLine: start };
      return { kind: "inline", path: finding.path, line: finding.line };
    }
  }
  return { kind: "file", path: finding.path };
}

export function hunkIndex(files: PullFile[]): Map<string, FileHunks> {
  return new Map(
    files.filter((file) => file.status !== "removed").map((file) => [file.filename, commentableLines(file.patch)]),
  );
}
