// Guards the packaged skill against CLI drift: the fenced help block in
// skills/jgrep/SKILL.md must stay byte-identical to cli.ts's USAGE, so a future
// `--help` change that forgets to regenerate the skill fails the suite.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";

declare const process: { cwd(): string; env: Record<string, string | undefined> };

// cli.ts auto-runs main() at import unless JGREP_NO_MAIN is set (cli.test.ts pattern).
process.env.JGREP_NO_MAIN = "1";
const { USAGE } = await import("./cli");

// Anchored to this file, not the CWD, so the suite runs from anywhere (bench/ pattern).
const HERE: string = (import.meta as { dir?: string }).dir ?? process.cwd();
const SKILL = path.join(HERE, "..", "skills", "jgrep", "SKILL.md");

const readSkill = (): string => {
  try {
    return fs.readFileSync(SKILL, "utf8");
  } catch {
    throw new Error(`missing ${SKILL} — the packaged skill spec (shipped via package.json "files"); restore it from git`);
  }
};

test("skill spec: skills/jgrep/SKILL.md exists and its frontmatter is name: jgrep", () => {
  const fm = readSkill().match(/^---\n([\s\S]*?)\n---/);
  expect(fm).not.toBeNull(); // frontmatter present
  expect(fm![1]).toMatch(/^name: jgrep$/m);
});

test("skill help: the embedded help block is byte-identical to cli.ts USAGE — regenerate from `node dist/jgrep.js --help`", () => {
  const usageLines = USAGE.split("\n");
  const lines = readSkill().split("\n");
  // The same anchored extraction init.ts uses in production: the run starts at
  // USAGE's own first line (nothing hardcoded — version or last line) and spans
  // exactly usageLines.length lines. A stale skill fails either at the anchor
  // (helpful throw below) or at the byte comparison.
  const start = lines.indexOf(usageLines[0]);
  if (start === -1)
    throw new Error(
      `skills/jgrep/SKILL.md: embedded help block not found — no line matching "${usageLines[0]}"; regenerate the embedded help from \`node dist/jgrep.js --help\``,
    );
  const extracted = lines.slice(start, start + usageLines.length);
  expect(extracted.join("\n")).toBe(USAGE);
});
