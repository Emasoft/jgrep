// Docs cannot drift from the code. cli.ts USAGE is built from the constants the code uses;
// these tests pin everything else to it:
// - the help blocks embedded in README.md and skills/jgrep/SKILL.md equal the live --help
//   output exactly (regenerate with `bun run sync-docs`);
// - the options parse() accepts (cli.ts FLAGS) are exactly the options --help names, both
//   ways, and so are the env vars the code reads;
// - every --flag and env var README.md and SKILL.md mention exists (a stale --no-probe fails).
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
import { HELP_DOCS, helpBlock } from "../scripts/sync-docs";
import { BUILTINS } from "./providers";
import { INIT_FLAGS } from "./init";

declare const process: { cwd(): string; env: Record<string, string | undefined> };
declare const Bun: { spawnSync(cmd: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }): { exitCode: number | null; stdout: { toString(): string } } };

// cli.ts auto-runs main() at import unless JGREP_NO_MAIN is set (cli.test.ts pattern).
process.env.JGREP_NO_MAIN = "1";
const { USAGE, FLAGS, STATUS_FLAGS, parse } = await import("./cli");

// Anchored to this file, not the CWD, so the suite runs from anywhere (bench/ pattern).
const HERE: string = (import.meta as { dir?: string }).dir ?? process.cwd();
const ROOT = path.join(HERE, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const LONG_FLAG_RE = /(?<![\w-])--[a-z][a-z0-9-]*/g;
const ENV_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const tokens = (text: string, re: RegExp): Set<string> => new Set(text.match(re) ?? []);
const sorted = (s: Iterable<string>): string[] => [...s].sort();
const minus = (a: Iterable<string>, b: Set<string>): string[] => sorted([...a].filter((x) => !b.has(x)));

test("skill spec: skills/jgrep/SKILL.md exists and its frontmatter is name: jgrep", () => {
  const fm = read("skills/jgrep/SKILL.md").match(/^---\n([\s\S]*?)\n---/);
  expect(fm).not.toBeNull(); // frontmatter present
  expect(fm![1]).toMatch(/^name: jgrep$/m);
});

test("--help prints USAGE exactly (stdout, exit 0)", () => {
  const r = Bun.spawnSync(["bun", "src/cli.ts", "--help"], { cwd: ROOT, env: { ...process.env, JGREP_NO_MAIN: "" } });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toBe(`${USAGE}\n`);
});

for (const doc of HELP_DOCS) {
  test(`${doc}: the embedded help block is exactly the --help output — run \`bun run sync-docs\``, () => {
    const lines = read(doc).split("\n");
    const { start, end } = helpBlock(lines, doc); // the whole fenced body: a stale extra line fails too
    expect(lines.slice(start, end).join("\n")).toBe(USAGE);
  });
}

test("FLAGS (what parse accepts) are exactly the options --help names, long and short", () => {
  // Every FLAGS entry has a branch in parse(): none is refused as unknown. (--help and
  // --version exit the process; the spawn test above covers --help.)
  for (const f of FLAGS) {
    if (["-h", "--help", "-v", "-V", "--version"].includes(f)) continue;
    let msg = "";
    try { parse([f, "1"]); } catch (e) { msg = (e as Error).message; }
    expect(`${f}: ${msg}`).not.toContain("unknown option");
  }
  // ...and parse() refuses any other option before looking at it.
  expect(() => parse(["--no-probe"])).toThrow("unknown option --no-probe");
  const long = sorted([...FLAGS].filter((f) => f.startsWith("--")));
  expect(sorted(tokens(USAGE, LONG_FLAG_RE))).toEqual(long);
  // Short options are listed in the option column: "  -t, --threshold", "  -v, -V, --version".
  const shortInHelp = USAGE.split("\n").flatMap((l) => /^ {2}(-[A-Za-z], )+--/.test(l) ? l.match(/(?<![\w-])-[A-Za-z](?=,)/g) ?? [] : []);
  expect(sorted(shortInHelp)).toEqual(sorted([...FLAGS].filter((f) => !f.startsWith("--"))));
});

test("the init and status usage lines name exactly the options those commands accept", () => {
  const line = (cmd: string) => USAGE.split("\n").find((l) => l.includes(`jgrep ${cmd} `)) ?? "";
  expect(sorted(tokens(line("init"), LONG_FLAG_RE))).toEqual(sorted(INIT_FLAGS));
  expect(sorted(tokens(line("status"), LONG_FLAG_RE))).toEqual(sorted(STATUS_FLAGS));
});

/** The env vars the production code reads: every `env.NAME` / `env["NAME"]` in src (not the
 *  tests), plus the variables the built-in providers' api_key / account_id name (read as
 *  env[name] at run time). */
const envRead = (): Set<string> => {
  const files = fs.readdirSync(HERE).filter((f: string) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "test-preload.ts");
  const names = new Set<string>();
  for (const f of files) {
    const src = fs.readFileSync(path.join(HERE, f), "utf8");
    for (const m of src.matchAll(/\benv(?:\.([A-Z_][A-Z0-9_]*)|\[["']([A-Z_][A-Z0-9_]*)["']\])/g)) names.add(m[1] ?? m[2]);
  }
  for (const b of BUILTINS)
    for (const ref of ([] as string[]).concat(b.api_key ?? [], b.account_id ?? [])) names.add(ref.replace(/^\$\{?|\}$/g, ""));
  return names;
};
/** Read by the code but deliberately not in --help, with the reason. */
const UNDOCUMENTED_ENV: Record<string, string> = {
  HOME: "only locates the pre-0.7 cache for a one-time 'can be deleted' note",
  XDG_CACHE_HOME: "only locates the pre-0.7 cache for a one-time 'can be deleted' note",
  JGREP_NO_MAIN: "test hook: import cli.ts without running main()",
};

test("the env vars the code reads are exactly the env vars --help documents", () => {
  const read = envRead();
  for (const n of Object.keys(UNDOCUMENTED_ENV)) expect(read.has(n)).toBe(true); // an exemption must still be real
  const documented = tokens(USAGE, ENV_RE);
  expect(minus(read, new Set([...documented, ...Object.keys(UNDOCUMENTED_ENV)]))).toEqual([]); // read, not in --help
  expect(minus(documented, read)).toEqual([]); // in --help, never read
});

/** Tokens the docs mention that belong to another tool, each with the file that defines it. */
const OTHER_TOOLS: Record<string, string> = {
  "--choice": "install-dev.sh", "--dry-run": "install-dev.sh", "--target": "install-dev.sh", "--yes": "install-dev.sh",
  "--hard": "install-dev.sh", // `git reset --hard`, which install-dev.sh runs
  "--fixture": "bench/accuracy.ts", "--limit": "bench/accuracy.ts",
  JGREP_DEV_DIR: "install-dev.sh", JGREP_E2E_LIVE: "src/e2e.live.test.ts",
};
/** Env-var-shaped words that are not env vars. */
const NOT_ENV = new Set(["EAI_AGAIN"]); // a Node DNS error code, listed among retried transport errors

test("every --flag and env var README.md and SKILL.md mention exists", () => {
  for (const [tok, file] of Object.entries(OTHER_TOOLS)) expect(`${tok} in ${file}: ${read(file).includes(tok)}`).toBe(`${tok} in ${file}: true`);
  const flags = new Set([...FLAGS, ...Object.keys(OTHER_TOOLS)]);
  const env = new Set([...envRead(), ...Object.keys(OTHER_TOOLS), ...NOT_ENV]);
  for (const doc of ["README.md", "skills/jgrep/SKILL.md"]) {
    const text = read(doc);
    expect(`${doc} unknown flags: ${minus(tokens(text, LONG_FLAG_RE), flags).join(" ")}`).toBe(`${doc} unknown flags: `);
    expect(`${doc} unknown env vars: ${minus(tokens(text, ENV_RE), env).join(" ")}`).toBe(`${doc} unknown env vars: `);
  }
});
