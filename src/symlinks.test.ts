// File listing safety (audit MINOR + USER "add an option to follow symlinks or not"):
// symlinks are skipped by default and reported; --follow-symlinks (JGREP_FOLLOW_SYMLINKS=1)
// follows them, deduped by realpath, loop-safe, and never through a link whose path OR
// target looks like a secret; a git ls-files failure other than "not a git repository"
// is reported once. (File SIZE limits live in src/maxbytes.test.ts.)
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect, spyOn } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import { execFileSync } from "node:child_process";
import { listFiles } from "./jgrep";

/** tmp/{proj/real.ts, outside/notes.txt, outside/.env, outside/id_rsa}; returns [root, proj]. */
const fixture = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-links-")));
  const proj = path.join(root, "proj");
  const outside = path.join(root, "outside");
  fs.mkdirSync(proj); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(proj, "real.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(outside, "notes.txt"), "plain notes\n");
  fs.writeFileSync(path.join(outside, ".env"), "OPENROUTER_API_KEY=sk-or-fake\n");
  fs.writeFileSync(path.join(outside, "id_rsa"), "-----BEGIN KEY-----\n");
  fs.writeFileSync(path.join(outside, "harmless.txt"), "nothing\n");
  return { root, proj, outside };
};
const quiet = () => spyOn(console, "error").mockImplementation(() => {});
const rel = (proj: string, files: string[]) => files.map((f) => path.relative(proj, f)).sort();

test("default: a symlink is skipped and reported, never read through", () => {
  const { root, proj, outside } = fixture();
  const err = quiet();
  try {
    fs.symlinkSync(path.join(outside, "notes.txt"), path.join(proj, "link.txt"));
    expect(rel(proj, listFiles([proj]))).toEqual(["real.ts"]);
    expect(err.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toMatch(/skipped 1 symlink.*--follow-symlinks/);
  } finally { err.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("default in a git repo: a TRACKED symlink is skipped too (git ls-files lists it)", () => {
  const { root, proj, outside } = fixture();
  const err = quiet();
  try {
    fs.symlinkSync(path.join(outside, "notes.txt"), path.join(proj, "docs.md"));
    const git = (...a: string[]) => execFileSync("git", ["-C", proj, ...a], { stdio: "ignore" });
    git("init", "-q"); git("add", "real.ts", "docs.md");
    expect(listFiles([proj]).map((f: string) => path.basename(f)).sort()).toEqual(["real.ts"]);
  } finally { err.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("--follow-symlinks: a normal target is followed", () => {
  const { root, proj, outside } = fixture();
  const err = quiet();
  try {
    fs.symlinkSync(path.join(outside, "notes.txt"), path.join(proj, "link.txt"));
    expect(rel(proj, listFiles([proj], { followSymlinks: true }))).toEqual(["link.txt", "real.ts"]);
  } finally { err.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("--follow-symlinks: a secret-looking link path OR target is still refused", () => {
  const { root, proj, outside } = fixture();
  const err = quiet();
  try {
    fs.symlinkSync(path.join(outside, ".env"), path.join(proj, "config.txt"));        // innocent name, secret target
    fs.symlinkSync(path.join(outside, "id_rsa"), path.join(proj, "readme.md"));       // innocent name, key target
    fs.symlinkSync(path.join(outside, "harmless.txt"), path.join(proj, "prod.pem"));  // secret name, innocent target
    expect(rel(proj, listFiles([proj], { followSymlinks: true }))).toEqual(["real.ts"]);
    expect(err.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toMatch(/skipped 3 symlink/);
  } finally { err.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("--follow-symlinks: a directory loop terminates and duplicates are deduped by realpath", () => {
  const { root, proj } = fixture();
  const err = quiet();
  try {
    fs.mkdirSync(path.join(proj, "sub"));
    fs.writeFileSync(path.join(proj, "sub", "b.ts"), "export const b = 2;\n");
    fs.symlinkSync(proj, path.join(proj, "sub", "loop"));                 // sub/loop -> proj (cycle)
    fs.symlinkSync(path.join(proj, "real.ts"), path.join(proj, "alias.ts")); // same file twice
    const files = rel(proj, listFiles([proj], { followSymlinks: true }));
    expect(files).toEqual(["real.ts", "sub/b.ts"].sort()); // each realpath once, no infinite walk
  } finally { err.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("git ls-files failing for a reason other than 'not a git repository' is reported once", () => {
  const { root, proj } = fixture();
  const err = quiet();
  try {
    listFiles([proj]); // not a repo: silent fallback to the walk
    expect(err).toHaveBeenCalledTimes(0);
    execFileSync("git", ["-C", proj, "init", "-q"], { stdio: "ignore" });
    fs.writeFileSync(path.join(proj, ".git", "index"), "garbage, not a git index"); // "index file corrupt"
    expect(rel(proj, listFiles([proj]))).toEqual(["real.ts"]); // still answers, via the walk
    expect(rel(proj, listFiles([proj]))).toEqual(["real.ts"]);
    expect(err).toHaveBeenCalledTimes(1); // once per process, not once per call
    expect(String(err.mock.calls[0][0])).toContain("git ls-files failed");
  } finally { err.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a file named explicitly and also listed under a named directory is listed once", () => {
  const { root, proj } = fixture();
  try {
    expect(listFiles([path.join(proj, "real.ts"), proj])).toHaveLength(1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- CLI wiring: --follow-symlinks and JGREP_FOLLOW_SYMLINKS=1 ---------------------

declare const Bun: { spawnSync(cmd: string[], opts?: { env?: Record<string, string | undefined> }): { exitCode: number | null; stdout: { toString(): string }; stderr: { toString(): string } } };

test("cli: --estimate lists a symlinked file only with --follow-symlinks or JGREP_FOLLOW_SYMLINKS=1", () => {
  const { root, proj, outside } = fixture();
  try {
    fs.symlinkSync(path.join(outside, "notes.txt"), path.join(proj, "link.txt"));
    const env = { ...process.env, JGREP_NO_MAIN: "", JGREP_FOLLOW_SYMLINKS: "" };
    const run = (args: string[], e = env) => Bun.spawnSync(["bun", "src/cli.ts", "--estimate", "--no-cache", ...args, "q", proj], { env: e });
    const plain = run([]);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout.toString()).not.toContain("link.txt");
    expect(plain.stderr.toString()).toContain("--follow-symlinks");
    expect(run(["--follow-symlinks"]).stdout.toString()).toContain("link.txt");
    expect(run([], { ...env, JGREP_FOLLOW_SYMLINKS: "1" }).stdout.toString()).toContain("link.txt");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 20_000);
