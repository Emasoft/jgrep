// Fork publish guard. This repo is a fork (Emasoft/jgrep): the `jevgrep` npm package
// belongs to upstream kyu1204/jgrep, so the fork must never publish it. Two locks:
// (1) every job of .github/workflows/publish.yml runs only when
//     `github.repository == 'kyu1204/jgrep'` (AND-ed first in its `if:`), so an upstream
//     sync that adds a job or drops the guard turns CI red here instead of publishing;
// (2) package.json is "private": true, so npm refuses `npm publish` outright (installs
//     from GitHub, curl or bun keep working).
// No YAML dependency: job keys sit at 2-space indent under `jobs:`, their `if:` at 4.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";

const ROOT = path.join((import.meta as { dir: string }).dir, "..");
const GUARD = "github.repository == 'kyu1204/jgrep'";

/** Jobs of a workflow whose `if:` does not START with the upstream-repo guard (followed by
 *  `&&` or nothing): `x || <guard>` would still run on the fork, so containment is not enough. */
export function unguardedJobs(yaml: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) return [];
  const bad: string[] = [];
  let job: string | null = null;
  let cond: string | null = null;
  const close = () => {
    if (job === null) return;
    const c = (cond ?? "").replace(/\s+/g, " ").trim();
    if (!(c === GUARD || c.startsWith(`${GUARD} &&`))) bad.push(job);
  };
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l)) break; // next top-level key: the jobs block ended
    const jm = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (jm) { close(); job = jm[1]; cond = null; continue; }
    const im = /^ {4}if:\s*(.*)$/.exec(l);
    if (im && job !== null) {
      // inline `if: expr`, or a folded/literal block (`>-`, `|`) on the deeper-indented lines
      const parts = /^[>|][-+]?$/.test(im[1].trim()) ? [] : [im[1].replace(/^\$\{\{\s*|\s*\}\}$/g, "")];
      while (i + 1 < lines.length && (/^ {6,}\S/.test(lines[i + 1]) || !lines[i + 1].trim())) parts.push(lines[++i].trim());
      cond = parts.join(" ");
    }
  }
  close();
  return bad;
}

test("publish.yml: every job runs only in the upstream repo (fork never publishes jevgrep)", () => {
  const yaml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "publish.yml"), "utf8");
  expect(yaml).toMatch(/^jobs:/m);
  expect(unguardedJobs(yaml)).toEqual([]);
});

test("unguardedJobs: detects a missing guard, an OR-ed guard, and a new unguarded job", () => {
  const guarded = "on: push\njobs:\n  a:\n    if: >-\n      github.repository == 'kyu1204/jgrep' &&\n      github.event_name == 'push'\n    runs-on: x\n";
  expect(unguardedJobs(guarded)).toEqual([]);
  expect(unguardedJobs("jobs:\n  a:\n    if: github.repository == 'kyu1204/jgrep'\n    runs-on: x\n")).toEqual([]);
  expect(unguardedJobs("jobs:\n  a:\n    runs-on: x\n    steps:\n      - run: npm publish\n")).toEqual(["a"]);
  expect(unguardedJobs("jobs:\n  a:\n    if: github.event_name == 'push' || github.repository == 'kyu1204/jgrep'\n")).toEqual(["a"]);
  expect(unguardedJobs(guarded + "  b:\n    runs-on: x\n")).toEqual(["b"]);
});

test("package.json is private: npm refuses to publish the fork", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  expect(pkg.private).toBe(true);
});
