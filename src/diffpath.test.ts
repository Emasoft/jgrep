// git diff header paths (audit NIT): git C-quotes names with special characters
// (`+++ "b/q\"t.ts"`, octal bytes for non-ASCII unless core.quotePath=false) and appends a
// TAB after a name that contains a space. diffChunks and the --tests diff readers used
// to take the raw header text, producing wrong file names.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import { execFileSync } from "node:child_process";
import { diffChunks, gitDiff } from "./jgrep";
import { changedFilesOf, compactDiff } from "./tests";

const hunk = (header: string) => `diff --git a/x b/x\n--- a/x\n${header}\n@@ -1 +1,2 @@\n a\n+b\n`;
const HEADERS: [string, string][] = [
  ['+++ "b/q\\"t.ts"', 'q"t.ts'],
  ["+++ b/sp ace.ts\t", "sp ace.ts"],
  ['+++ "b/ta\\tb.ts"', "ta\tb.ts"],
  ['+++ "b/\\303\\274.ts"', "ü.ts"],
  ["+++ b/plain.ts", "plain.ts"],
  ['+++ "b/\u{1F600}\\t.ts"', "\u{1F600}\t.ts"], // raw astral char inside quotes (core.quotePath=false)
];

test("diffChunks decodes quoted, octal-escaped and TAB-terminated header paths", () => {
  for (const [header, file] of HEADERS) expect(diffChunks(hunk(header)).map((c) => c.file)).toEqual([file]);
});

test("--tests diff readers (changedFilesOf, compactDiff) decode the same header forms", () => {
  const diff = HEADERS.map(([h]) => hunk(h)).join("");
  expect(changedFilesOf(diff)).toEqual(HEADERS.map(([, f]) => f));
  expect(compactDiff(diff)).toContain("  sp ace.ts\n");
  expect(compactDiff(diff)).toContain("  ü.ts\n");
});

test("gitDiff + diffChunks on a real repo: names with spaces and non-ASCII come back intact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-qpath-"));
  try {
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
    git("init", "-q");
    for (const f of ["sp ace.ts", "ü.ts"]) fs.writeFileSync(path.join(dir, f), "a\n");
    git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i");
    for (const f of ["sp ace.ts", "ü.ts"]) fs.appendFileSync(path.join(dir, f), "b\n");
    expect(diffChunks(gitDiff([], dir)).map((c) => c.file).sort()).toEqual(["sp ace.ts", "ü.ts"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
