// `jgrep init` (TRDD-3KBUODCE): init() itself is interactive (@clack), so the wizard's branch
// logic is extracted into exported pure helpers in init.ts and covered here — plus the save
// path (withEntry -> saveProviders -> loadProviders) end to end, in temp homes only.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
declare const process: { env: Record<string, string | undefined>; platform: string };

import { BACKENDS, builtinDoc, loadProviders } from "./providers";
import {
  PROVIDER_CHOICES, agentsSkillDir, compatibleEndpoint, currentDoc, existingKeyMessage, installToAgentsDir,
  keyPromptMessage, legacySkillCopies, outroLine, rejectionHint, saveProviders, skillsInstallCommand, verifyHost, withEntry,
} from "./init";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-i-"));
const errOf = (fn: () => unknown): Error => {
  try { fn(); } catch (e) { return e as Error; }
  throw new Error("expected fn to throw");
};

test("compatibleEndpoint: the full System One URL becomes base_url + path; bad URLs get a plain, clear Error", () => {
  expect(compatibleEndpoint("  https://gw.example.com/v1/systemone  ")).toEqual({ base_url: "https://gw.example.com", path: "/v1/systemone" });
  expect(compatibleEndpoint("http://localhost:11434/v1/systemone")).toEqual({ base_url: "http://localhost:11434", path: "/v1/systemone" });
  const e = errOf(() => compatibleEndpoint("ftp://x/v1/systemone"));
  expect(e.constructor).toBe(Error); // plain Error — the wizard re-prompts on message
  expect(e.message).toContain("must be https://");
  // cleartext to a remote host would carry the key in the clear (upstream #19 rule)
  expect(errOf(() => compatibleEndpoint("http://gw.example.com/v1/systemone")).message).toContain("must be https://");
  expect(errOf(() => compatibleEndpoint("https://gw.example.com/v1/systemone?token=x")).message).toContain("query");
  for (const bad of ["not a url", "", "   "]) expect(errOf(() => compatibleEndpoint(bad)).message).toContain("not a valid URL");
});

test("PROVIDER_CHOICES: every built-in, in built-in chain order (openrouter first)", () => {
  expect(PROVIDER_CHOICES.map((o) => o.value)).toEqual(["openrouter", "typesafe", "compatible", "cloudflare", "vercel"]);
  expect(PROVIDER_CHOICES[0].label).toContain("openrouter.ai/api/v1/systemone");
  expect(PROVIDER_CHOICES[1].label).toContain("api.typesafe.ai");
});

test("keyPromptMessage: provider-specific paste text with the right console/keys URL", () => {
  expect(keyPromptMessage("typesafe")).toContain("https://console.typesafe.ai");
  expect(keyPromptMessage("openrouter")).toContain("https://openrouter.ai/settings/keys");
  expect(keyPromptMessage("cloudflare")).toContain("Workers AI");
  expect(keyPromptMessage("compatible")).toContain("Authorization: Bearer");
});

test("verifyHost: names the host actually checked (the free check, else the endpoint)", () => {
  expect(verifyHost(BACKENDS.typesafe)).toBe("Checking the key against api.typesafe.ai");
  expect(verifyHost(BACKENDS.openrouter)).toBe("Checking the key against openrouter.ai");
  expect(verifyHost({ ...BACKENDS.compatible, url: "https://gw.example.com/v1/systemone" })).toBe("Checking the key against gw.example.com");
});

test("rejectionHint: only 404 gets the pin-version hint", () => {
  expect(rejectionHint(404)).toBe("the provider may need an explicit --model version");
  expect(rejectionHint(401)).toBeUndefined();
  expect(rejectionHint(0)).toBeUndefined(); // transport failure, not a rejection status
});

test("existingKeyMessage: names the provider and where the key comes from, masks it to its last 4 chars", () => {
  const m = existingKeyMessage("typesafe", "sk-1234567890", "$TYPESAFE_API_KEY");
  expect(m).toContain("typesafe");
  expect(m).toContain("…7890");
  expect(m).toContain("$TYPESAFE_API_KEY");
  expect(m).not.toContain("sk-1234");
});

test("outroLine: mentions the model in play via the chosen provider", () => {
  expect(outroLine(BACKENDS.typesafe)).toBe("Ready (jev-latest via typesafe).");
  expect(outroLine(BACKENDS.openrouter, "typesafe/jev-1.13")).toBe("Ready (typesafe/jev-1.13 via openrouter).");
});

test("withEntry: merges fields into one entry (appended when missing), optionally moves it first, keeps the rest as written", () => {
  const doc = { version: 1 as const, providers: [{ name: "openrouter" }, { name: "typesafe", enabled: "off" }] };
  expect(withEntry(doc, "typesafe", { api_key: "k" }).providers).toEqual([{ name: "openrouter" }, { name: "typesafe", enabled: "off", api_key: "k" }]);
  expect(withEntry(doc, "typesafe", {}, true).providers.map((e) => e.name)).toEqual(["typesafe", "openrouter"]);
  expect(withEntry(doc, "vercel", { api_key: "$AI_GATEWAY_API_KEY" }).providers.map((e) => e.name)).toEqual(["openrouter", "typesafe", "vercel"]);
  expect(doc.providers).toEqual([{ name: "openrouter" }, { name: "typesafe", enabled: "off" }]); // the input is never mutated
});

test("saveProviders: validated, 0600 in a 0700 home, atomic; the next run reads the saved literal key", () => {
  const home = tmp();
  const env = { JGREP_HOME: path.join(home, ".jgrep") };
  const file = saveProviders(withEntry(builtinDoc(), "openrouter", { api_key: "sk-or-saved-key" }), env);
  expect(file).toBe(path.join(home, ".jgrep", "providers.json"));
  if (process.platform !== "win32") {
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  }
  expect(fs.readdirSync(path.dirname(file))).toEqual(["providers.json"]); // no temp file left behind
  const p = loadProviders(env, tmp(), tmp()).providers[0];
  expect([p.name, p.key, p.keySource]).toEqual(["openrouter", "sk-or-saved-key", "literal in providers.json"]);
  // an invalid document is never written: the next run must accept the file
  expect(() => saveProviders({ version: 1, providers: [{ name: "typesafe", colour: "red" } as never] }, env)).toThrow(/unknown field/);
  expect(JSON.parse(fs.readFileSync(file, "utf8")).providers[0].api_key).toBe("sk-or-saved-key");
});

test("currentDoc: every built-in by name when there is no file; a broken file stops init before any prompt", () => {
  const env = { JGREP_HOME: tmp() };
  expect(currentDoc(env)).toEqual({ doc: builtinDoc(), exists: false });
  fs.writeFileSync(path.join(env.JGREP_HOME, "providers.json"), "{oops", { mode: 0o600 });
  expect(() => currentDoc(env)).toThrow(/not valid JSON/);
});

// ---- universal skills installer (vercel-labs/skills) --------------------------

test("skillsInstallCommand: exact installer argv, path with spaces stays one argv element", () => {
  expect(skillsInstallCommand("/repo/skills"))
    .toEqual(["npx", "-y", "skills@1.7.0", "add", "/repo/skills", "-g", "-y"]); // pinned (audit), same pin as install-dev.sh
  const spaced = "/Users/me/My Code/jgrep/skills";
  expect(skillsInstallCommand(spaced)).toEqual(["npx", "-y", "skills@1.7.0", "add", spaced, "-g", "-y"]);
  expect(skillsInstallCommand(spaced)[4]).toBe(spaced); // never re-split: spawned with shell:false
});

test("agentsSkillDir: ~/.agents/skills/jgrep under the given home", () => {
  expect(agentsSkillDir("/home/u")).toBe(path.join("/home/u", ".agents", "skills", "jgrep"));
  expect(agentsSkillDir("/")).toBe(path.join("/", ".agents", "skills", "jgrep"));
});

test("installToAgentsDir: mkdir-p + copies SKILL.md into a temp home, content equal", () => {
  const home = tmp(), src = path.join(tmp(), "SKILL.md");
  fs.writeFileSync(src, "---\nname: jgrep\n---\nbody");
  expect(installToAgentsDir(src, home)).toBeUndefined(); // void per contract
  const dest = path.join(home, ".agents", "skills", "jgrep", "SKILL.md");
  expect(fs.readFileSync(dest, "utf8")).toBe("---\nname: jgrep\n---\nbody");
  expect(agentsSkillDir(home)).toBe(path.dirname(dest)); // helper agreement
});

test("installToAgentsDir: overwrites an older copy with the new content", () => {
  const home = tmp(), src = path.join(tmp(), "SKILL.md");
  fs.writeFileSync(src, "old");
  installToAgentsDir(src, home);
  fs.writeFileSync(src, "new");
  installToAgentsDir(src, home);
  expect(fs.readFileSync(path.join(agentsSkillDir(home), "SKILL.md"), "utf8")).toBe("new");
});

// Ported from upstream's installSkills symlink tests (jgrep.test.ts there).
test("installToAgentsDir: replaces a dangling or live symlink with a real dir, link target untouched", () => {
  for (const live of [false, true]) {
    const home = tmp(), src = path.join(tmp(), "SKILL.md");
    fs.writeFileSync(src, "new");
    const repo = path.join(home, "repo-skill");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "SKILL.md"), "old");
    fs.mkdirSync(path.dirname(agentsSkillDir(home)), { recursive: true });
    fs.symlinkSync(live ? repo : path.join(home, "gone"), agentsSkillDir(home));
    installToAgentsDir(src, home);
    expect(fs.lstatSync(agentsSkillDir(home)).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(agentsSkillDir(home), "SKILL.md"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(repo, "SKILL.md"), "utf8")).toBe("old");
  }
});

test("installToAgentsDir: throws instead of copying through a symlink it could not remove", () => {
  if ((process as unknown as { getuid?: () => number }).getuid?.() === 0) return; // root ignores the read-only dir
  const home = tmp(), src = path.join(tmp(), "SKILL.md");
  fs.writeFileSync(src, "new");
  const repo = path.join(home, "repo-skill");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "SKILL.md"), "old");
  const skills = path.dirname(agentsSkillDir(home));
  fs.mkdirSync(skills, { recursive: true });
  fs.symlinkSync(repo, agentsSkillDir(home));
  fs.chmodSync(skills, 0o555);
  try {
    expect(() => installToAgentsDir(src, home)).toThrow();
  } finally {
    fs.chmodSync(skills, 0o755);
  }
  expect(fs.readFileSync(path.join(repo, "SKILL.md"), "utf8")).toBe("old");
});

test("legacySkillCopies: lists pre-0.4 claude/codex copies that exist, ignores the rest", () => {
  const home = tmp();
  expect(legacySkillCopies(home)).toEqual([]); // nothing installed
  fs.mkdirSync(path.join(home, ".claude", "skills", "jgrep"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "skills", "jgrep", "SKILL.md"), "old");
  expect(legacySkillCopies(home)).toEqual([path.join(home, ".claude", "skills", "jgrep", "SKILL.md")]);
  fs.mkdirSync(path.join(home, ".codex", "skills", "jgrep"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "skills", "jgrep", "SKILL.md"), "old");
  expect(legacySkillCopies(home)).toEqual([
    path.join(home, ".claude", "skills", "jgrep", "SKILL.md"),
    path.join(home, ".codex", "skills", "jgrep", "SKILL.md"),
  ]);
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true }); // unknown agent home: not legacy
  expect(legacySkillCopies(home)).not.toContain(path.join(home, ".cursor", "skills", "jgrep", "SKILL.md"));
});

test("parseInitArgs (review n4): --request-timeout <s> sets the key-check timeout; junk is rejected", async () => {
  const { parseInitArgs } = await import("./init");
  expect(parseInitArgs([])).toEqual({ requestTimeoutSec: 15 });
  expect(parseInitArgs(["--request-timeout", "40"])).toEqual({ requestTimeoutSec: 40 });
  expect(() => parseInitArgs(["--request-timeout", "0"])).toThrow(/positive/);
  expect(() => parseInitArgs(["--bogus"])).toThrow(/unknown option/);
});
