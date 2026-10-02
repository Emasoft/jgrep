// Rewrites the `jgrep --help` blocks embedded in README.md and skills/jgrep/SKILL.md from
// src/cli.ts USAGE, the single source: `bun run sync-docs`. Idempotent — a second run finds
// nothing to change. src/skill.test.ts fails while a block differs from USAGE, so a --help
// change that forgets this step cannot land.
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";

declare const process: { env: Record<string, string | undefined> };

const ROOT: string = path.join((import.meta as { dir?: string }).dir ?? ".", "..");
/** The docs that embed the full help, relative to the repo root. */
export const HELP_DOCS = ["README.md", "skills/jgrep/SKILL.md"];

/** The body of THE fenced block whose first line is the help's title (`jgrep <version> — `,
 *  any version, so a version bump still finds the stale block): [start, end) line indexes.
 *  Exactly one such block per doc; anything else throws. */
export function helpBlock(lines: string[], doc: string): { start: number; end: number } {
  const starts = lines.flatMap((l, i) => (i > 0 && lines[i - 1] === "```" && /^jgrep \S+ — /.test(l) ? [i] : []));
  if (starts.length !== 1) throw new Error(`${doc}: expected exactly one fenced \`jgrep --help\` block, found ${starts.length}`);
  const end = lines.indexOf("```", starts[0]);
  if (end === -1) throw new Error(`${doc}: the \`jgrep --help\` block is never closed`);
  return { start: starts[0], end };
}

/** `text` with its help block's body replaced by `usage`. */
export function withHelp(text: string, usage: string, doc: string): string {
  const lines = text.split("\n");
  const { start, end } = helpBlock(lines, doc);
  return [...lines.slice(0, start), ...usage.split("\n"), ...lines.slice(end)].join("\n");
}

if ((import.meta as { main?: boolean }).main) {
  process.env.JGREP_NO_MAIN = "1"; // import USAGE without running the CLI
  const { USAGE } = await import("../src/cli");
  for (const doc of HELP_DOCS) {
    const file = path.join(ROOT, doc);
    const before = fs.readFileSync(file, "utf8");
    const after = withHelp(before, USAGE, doc);
    if (after === before) console.log(`${doc}: up to date`);
    else { fs.writeFileSync(file, after); console.log(`${doc}: help block rewritten`); }
  }
}
