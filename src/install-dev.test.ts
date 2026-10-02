// install-dev.sh option 8 safety (audit MAJOR): the script-managed clone is updated with
// `git reset --hard origin/main`, so it must only ever run on a directory the script
// itself created and that holds no local work. Exercised through --dry-run, which applies
// the same gates as a real run and mutates nothing. Plus: the bun auto-install asks unless
// --yes is EXPLICIT (--choice alone no longer implies it), and the `skills` installer is pinned.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect, afterAll } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import { execFileSync } from "node:child_process";

declare const Bun: { spawnSync(cmd: string[], opts?: { env?: Record<string, string | undefined> }): { exitCode: number | null; stdout: { toString(): string }; stderr: { toString(): string } } };

const SCRIPT = path.resolve("install-dev.sh");

/** A fake script-managed clone: a git repo on `main` with one commit and the given origin. */
const clone = (o: { origin?: string; marker?: boolean; dirty?: boolean; branch?: string } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-idev-"));
  const d = path.join(root, "clone");
  fs.mkdirSync(d);
  const git = (...a: string[]) => execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(d, "README.md"), "x\n");
  git("add", "README.md"); git("commit", "-qm", "init");
  git("remote", "add", "origin", o.origin ?? "https://github.com/Emasoft/jgrep.git");
  if (o.marker !== false) fs.writeFileSync(path.join(d, ".git", "jgrep-managed"), "created by install-dev.sh option 8\n");
  if (o.dirty) fs.writeFileSync(path.join(d, "README.md"), "local work\n");
  if (o.branch) git("checkout", "-qb", o.branch);
  return { root, d };
};

// Hermetic PATH: system dirs plus a dir holding only `bun`. The script's environment scan
// probes every npm/brew on PATH (`npm ls -g`, `brew list`, and `npm view` over the network),
// which cost 15-30 s per dry run on a dev box and made these tests time out in the full
// suite. Option 8's gates need none of it, and the host's global installs must not leak in.
const BUN_ONLY = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-idev-bin-"));
fs.symlinkSync(process.execPath, path.join(BUN_ONLY, "bun"));
const HERMETIC_PATH = `${BUN_ONLY}:/usr/bin:/bin:/usr/sbin:/sbin`;

afterAll(() => fs.rmSync(BUN_ONLY, { recursive: true, force: true }));

const dry8 = (dir: string, root: string, extra: string[] = [], env: Record<string, string> = {}) => {
  const target = path.join(root, "bin");
  fs.mkdirSync(target, { recursive: true });
  const r = Bun.spawnSync(["bash", SCRIPT, "--choice", "8", "--dry-run", "--target", target, ...extra], { env: { ...process.env, PATH: HERMETIC_PATH, HOME: root, JGREP_DEV_DIR: dir, ...env } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

test("option 8: a managed, clean clone on main passes the gates (dry run, exit 0)", () => {
  const { root, d } = clone();
  try {
    const r = dry8(d, root);
    expect(r.out).toContain("reset --hard origin/main");
    expect(r.code).toBe(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("option 8: the ssh form of the fork's origin is accepted too", () => {
  const { root, d } = clone({ origin: "git@github.com:Emasoft/jgrep.git" });
  try { expect(dry8(d, root).code).toBe(0); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("option 8: an origin that merely CONTAINS Emasoft/jgrep is refused (exact match only)", () => {
  const { root, d } = clone({ origin: "https://github.com/Emasoft/jgrep-sync.git" });
  try {
    const r = dry8(d, root);
    expect(r.code).toBe(1); // before: substring match accepted it
    expect(r.out).toContain("not a clone of the fork");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("option 8: a clone the script did not create (no marker) is never reset", () => {
  const { root, d } = clone({ marker: false });
  try {
    const r = dry8(d, root);
    expect(r.code).toBe(1); // before: reset --hard went ahead on any matching clone
    expect(r.out).toContain("jgrep-managed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("option 8: uncommitted changes or a HEAD off main refuse the reset", () => {
  const dirty = clone({ dirty: true });
  const branch = clone({ branch: "feature" });
  try {
    const a = dry8(dirty.d, dirty.root);
    expect(a.code).toBe(1);
    expect(a.out).toContain("uncommitted changes");
    const b = dry8(branch.d, branch.root);
    expect(b.code).toBe(1);
    expect(b.out).toContain("not on main");
  } finally { fs.rmSync(dirty.root, { recursive: true, force: true }); fs.rmSync(branch.root, { recursive: true, force: true }); }
});

test("option 8: a missing bun is installed only after a yes — --choice alone asks, --yes skips the question", () => {
  const { root, d } = clone();
  try {
    const noBun = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }; // git/curl stay, bun is gone
    // without --yes: asked on a terminal, refused without one — never installed unasked
    const plain = dry8(d, root, [], noBun).out;
    expect(plain).toMatch(/would ask before installing bun|would refuse \(exit 3\) unless --yes/);
    expect(plain).not.toContain("without asking"); // before: "--choice" alone auto-installed it
    expect(dry8(d, root, ["--yes"], noBun).out).toContain("would install bun without asking (--yes)");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the vercel `skills` installer is pinned to an exact version (never the floating latest)", async () => {
  const text = fs.readFileSync(SCRIPT, "utf8");
  expect(text).not.toMatch(/npx -y skills add/);
  expect(text).toMatch(/SKILLS_PKG="skills@\d+\.\d+\.\d+"/);
  const { skillsInstallCommand } = await import("./init");
  expect(skillsInstallCommand("/x")[2]).toMatch(/^skills@\d+\.\d+\.\d+$/);
});
