// CLI-surface tests: parse() flag types/defaults/numeric validation for the five
// reliability flags, the exported writeOut() helper, and the --json array-shape
// contract through the real entrypoint. The end-to-end tests are hermetic: the
// child process runs with HOME pointed at a temp dir whose ~/.cache/jgrep is
// pre-seeded, so every chunk/row is a cache hit — zero network, zero key files.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
import { createHash } from "node:crypto";
import { MODEL } from "./jgrep";

process.env.JGREP_NO_MAIN = "1";
const { parse, writeOut } = await import("./cli");

declare const Bun: {
  spawnSync(cmd: string[], opts?: { env?: Record<string, string | undefined>; cwd?: string }): {
    exitCode: number | null;
    stdout: { toString(): string };
    stderr: { toString(): string };
  };
};

// ---- parse(): the five reliability flags ----------------------------------------

test("cli parse: reliability flags parse with correct types and defaults", () => {
  const o = parse(["q"]);
  expect(o).toMatchObject({ timeout: 15, requestTimeout: 30, retries: 4, rate: 0, failFast: false });
  expect(typeof o.timeout).toBe("number");
  expect(typeof o.requestTimeout).toBe("number");
  expect(typeof o.retries).toBe("number");
  expect(typeof o.rate).toBe("number");
  expect(typeof o.failFast).toBe("boolean");

  const o2 = parse(["--timeout", "30", "--request-timeout", "60", "--retries", "2", "--rate", "5", "--fail-fast", "q", "src/"]);
  expect(o2).toMatchObject({ timeout: 30, requestTimeout: 60, retries: 2, rate: 5, failFast: true, question: "q", paths: ["src/"] });
});

test("cli parse: numeric validation covers the new numerics (timeout/request-timeout/retries/rate)", () => {
  for (const flag of ["--timeout", "--request-timeout", "--retries", "--rate"]) {
    expect(() => parse([flag, "abc", "q"])).toThrow(/numeric option expected/);
    expect(() => parse([flag, "-1", "q"])).toThrow(/numeric option expected/);
  }
  expect(() => parse(["--timeout", "0", "--request-timeout", "0", "--retries", "0", "--rate", "0", "q"])).not.toThrow(); // 0 is legal
});

test("cli parse: old and new flags coexist (--diff positional heuristic untouched)", () => {
  const o = parse(["--diff", "--json", "--fail-fast", "--staged", "q"]);
  expect(o).toMatchObject({ json: true, failFast: true, diff: ["--staged"], question: "q" });
  const o2 = parse(["--diff", "origin/main", "--rate", "10", "q", "src/"]);
  expect(o2).toMatchObject({ diff: ["origin/main"], rate: 10, question: "q", paths: ["src/"] });
});

// ---- writeOut(): file when a path is given, stdout otherwise ---------------------

test("writeOut: writes the file and reports it landed; no path goes to stdout and reports false", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-writeout-"));
  try {
    const out = path.join(dir, "o.json");
    expect(writeOut(out, "[1,2]")).toBe(true); // a file actually landed
    expect(fs.readFileSync(out, "utf8")).toBe("[1,2]");

    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: string) => logs.push(s);
    try { expect(writeOut("", "stdout-payload")).toBe(false); } finally { console.log = orig; }
    expect(logs).toEqual(["stdout-payload"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- main() via the real entrypoint: the --json array-shape contract -------------
// Pre-seeding the child's HOME cache makes the whole run a cache hit: no network,
// no key files, and the v0.3.0 output shape is proven end to end.

const cliPath = path.join(import.meta.dir, "cli.ts");

/** A temp project + temp HOME whose ~/.cache/jgrep holds `entries`. */
const seedHome = (entries: Record<string, unknown>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-json-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".cache", "jgrep"), { recursive: true });
  fs.writeFileSync(path.join(home, ".cache", "jgrep", "cache.json"), JSON.stringify(entries));
  return { dir, home };
};

const runCli = (args: string[], cwd: string, home: string) =>
  Bun.spawnSync(["bun", cliPath, ...args], {
    cwd,
    env: { ...process.env, JGREP_NO_MAIN: "", HOME: home, TYPESAFE_API_KEY: "test-key" },
  });

test("cli main code: --json emits the bare v0.3.0 hit array with exactly {file,start,end,p,text}", () => {
  const q = "json shape contract probe 7f3a";
  // 8 indented lines, no trailing newline: chunk() yields exactly one chunk whose
  // text is the whole file, so the cache key is computable from here.
  const text = Array.from({ length: 8 }, (_, i) => `  const v${i} = ${i};`).join("\n");
  const codeKey = createHash("sha1").update(`${MODEL}\0code\0${q}\0${text}`).digest("hex");
  const { dir, home } = seedHome({ [codeKey]: 0.9 });
  try {
    fs.writeFileSync(path.join(dir, "probe.ts"), text);
    const p = runCli(["--json", q, "probe.ts"], dir, home);
    expect(p.exitCode).toBe(0);
    const parsed = JSON.parse(p.stdout.toString());
    expect(Array.isArray(parsed)).toBe(true); // bare array — no wrapper, no errors field
    expect(parsed).toHaveLength(1);
    for (const h of parsed) expect(Object.keys(h).sort()).toEqual(["end", "file", "p", "start", "text"]);
    expect(parsed[0]).toMatchObject({ file: "probe.ts", start: 1, end: 8, p: 0.9 });
    // and without --json the pretty line still names the file
    const p2 = runCli([q, "probe.ts"], dir, home);
    expect(p2.exitCode).toBe(0);
    expect(p2.stdout.toString()).toContain("probe.ts");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli main rows: --json emits the position-aligned flattened answer array", () => {
  const q = "rows json contract probe be41";
  const questions = { match: { type: "noul", instructions: q } };
  const qJson = JSON.stringify(questions);
  const rowKey = (handle: string) =>
    createHash("sha1").update(`${MODEL}\0rows\0${qJson}\0${JSON.stringify({ handle })}`).digest("hex");
  // Both rows cached: the run is a pure cache hit (zero requests, zero network).
  const { dir, home } = seedHome({
    [rowKey("@a")]: { match: { type: "noul", noul: 0.9 } },
    [rowKey("@b")]: { match: { type: "noul", noul: 0.9 } },
  });
  try {
    fs.writeFileSync(path.join(dir, "rows.csv"), "handle\n@a\n@b\n");
    const p = runCli(["--rows", "rows.csv", "--json", q], dir, home);
    expect(p.exitCode).toBe(0);
    const parsed = JSON.parse(p.stdout.toString());
    expect(Array.isArray(parsed)).toBe(true); // bare flattened array, position-aligned
    expect(parsed).toHaveLength(2);
    expect(Object.keys(parsed).length).toBe(2); // dense: no skipped index
    expect(parsed).toEqual([{ match: 0.9 }, { match: 0.9 }]);
    // and without --json the pretty line still names row 2 (csv line numbers)
    const p2 = runCli(["--rows", "rows.csv", q], dir, home);
    expect(p2.exitCode).toBe(0);
    expect(p2.stdout.toString()).toContain("rows.csv:2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
