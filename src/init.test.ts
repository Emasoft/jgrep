// Step 8 tests: init() itself is interactive (@clack), so the wizard's branch logic
// is extracted into exported pure helpers in init.ts and covered here — plus the
// storage wiring (writeKeyFile -> keyFilePath -> resolveApiKey) end to end.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
declare const process: { env: Record<string, string | undefined>; platform: string };

import { BACKENDS, keyFilePath, readKeyFile, resolveApiKey, writeKeyFile } from "./providers";
import {
  PROVIDER_CHOICES, agentsSkillDir, existingKeyMessage, gatewayBackend, installToAgentsDir,
  keyPromptMessage, legacySkillCopies, mergeLegacyEnv, outroLine, rejectionHint,
  skillsInstallCommand, storageLine, storageOptions, verifyHost,
} from "./init";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-i-"));
const errOf = (fn: () => unknown): Error => {
  try { fn(); } catch (e) { return e as Error; }
  throw new Error("expected fn to throw");
};

test("gatewayBackend: accepts an http(s) URL and returns a BACKENDS.gateway copy with url set", () => {
  const b = gatewayBackend("https://x/v1/systemone");
  expect(b).toEqual({ ...BACKENDS.gateway, url: "https://x/v1/systemone" });
  expect(b.name).toBe("gateway");
  expect(b.model).toBe("jev-latest");
  expect(b.keyEnv).toBe("JEV_GATEWAY_API_KEY");
  expect(BACKENDS.gateway.url).toBe(""); // registry never mutated
  expect(gatewayBackend("  https://gw.example.com/v1/systemone  ").url).toBe("https://gw.example.com/v1/systemone"); // trimmed
});

test("gatewayBackend: rejects ftp://, garbage and empty with a plain, clear Error", () => {
  const e = errOf(() => gatewayBackend("ftp://x/v1/systemone"));
  expect(e.constructor).toBe(Error); // plain Error — the wizard re-prompts on message, not on JevProviderError
  expect(e.message).toContain("must be http(s)");
  expect(e.message).toContain("ftp:");
  expect(errOf(() => gatewayBackend("not a url")).message).toContain("not a valid URL");
  expect(errOf(() => gatewayBackend("")).message).toContain("not a valid URL");
  expect(errOf(() => gatewayBackend("   ")).message).toContain("not a valid URL");
});

test("PROVIDER_CHOICES: the three backends in registry order, labels name host/protocol", () => {
  expect(PROVIDER_CHOICES.map((o) => o.value)).toEqual(["typesafe", "openrouter", "gateway"]);
  expect(PROVIDER_CHOICES[0].label).toContain("api.typesafe.ai");
  expect(PROVIDER_CHOICES[1].label).toContain("openrouter.ai/api/alpha/decisions");
  expect(PROVIDER_CHOICES[2].label).toContain("gateway");
});

test("keyPromptMessage: provider-specific paste text with the right console/keys URL", () => {
  expect(keyPromptMessage(BACKENDS.typesafe)).toContain("TypeSafe API key");
  expect(keyPromptMessage(BACKENDS.typesafe)).toContain("https://console.typesafe.ai");
  expect(keyPromptMessage(BACKENDS.openrouter)).toContain("OpenRouter API key");
  expect(keyPromptMessage(BACKENDS.openrouter)).toContain("https://openrouter.ai/keys");
  expect(keyPromptMessage(gatewayBackend("https://gw.example.com/v1/systemone"))).toContain("Authorization: Bearer");
});

test("verifyHost: names the actual backend host, never a hardcoded one", () => {
  expect(verifyHost(BACKENDS.typesafe)).toBe("Checking the key against api.typesafe.ai");
  expect(verifyHost(BACKENDS.openrouter)).toBe("Checking the key against openrouter.ai");
  expect(verifyHost(gatewayBackend("https://gw.example.com/v1/systemone"))).toBe("Checking the key against gw.example.com");
});

test("rejectionHint: only 404 gets the alpha pin-version hint", () => {
  expect(rejectionHint(404)).toBe("the alpha surface may need an explicit --model version");
  expect(rejectionHint(401)).toBeUndefined();
  expect(rejectionHint(403)).toBeUndefined();
  expect(rejectionHint(0)).toBeUndefined(); // transport failure, not a rejection status
});

test("storageOptions: four choices, key file first (default), none's hint names the key env", () => {
  const opts = storageOptions(BACKENDS.openrouter);
  expect(opts.map((o) => o.value)).toEqual(["keyfile", "legacy", "project", "none"]);
  expect(opts[0].label).toContain("openrouter.key");
  expect(opts[1].label).toContain(path.join(".config", "jgrep", "env"));
  expect(opts[2].hint).toContain(".gitignore");
  expect(opts[3].hint).toContain("OPENROUTER_API_KEY");
});

test("storageLine: one human summary per branch, key env interpolated", () => {
  const b = BACKENDS.openrouter, home = tmp();
  expect(storageLine(b, "keyfile", home)).toBe(`Saved to ${keyFilePath("openrouter", home)} (mode 600)`);
  expect(storageLine(b, "legacy", home)).toContain(path.join(home, ".config", "jgrep", "env"));
  expect(storageLine(b, "legacy", home)).toContain("OPENROUTER_API_KEY");
  expect(storageLine(b, "project", home)).toBe("Appended OPENROUTER_API_KEY to ./.env");
  expect(storageLine(b, "none", home)).toContain("export OPENROUTER_API_KEY");
  expect(storageLine(b, "mystery", home)).toBe(storageLine(b, "none", home)); // unknown falls back to "not saved"
});

test("existingKeyMessage: names the provider and masks the key to its last 4 chars", () => {
  const m = existingKeyMessage(BACKENDS.typesafe, "sk-1234567890");
  expect(m).toContain("typesafe");
  expect(m).toContain("…7890");
  expect(m).not.toContain("sk-1234");
});

test("mergeLegacyEnv: appends KEYENV=<key>, drops a stale line for the same key, keeps the rest", () => {
  expect(mergeLegacyEnv(null, "OPENROUTER_API_KEY", "k1")).toBe("OPENROUTER_API_KEY=k1\n");
  expect(mergeLegacyEnv("", "OPENROUTER_API_KEY", "k1")).toBe("OPENROUTER_API_KEY=k1\n");
  expect(mergeLegacyEnv("TYPESAFE_API_KEY=t\n", "OPENROUTER_API_KEY", "k1"))
    .toBe("TYPESAFE_API_KEY=t\nOPENROUTER_API_KEY=k1\n"); // other providers' entries survive
  expect(mergeLegacyEnv("OPENROUTER_API_KEY=old\nTYPESAFE_API_KEY=t\n", "OPENROUTER_API_KEY", "new"))
    .toBe("TYPESAFE_API_KEY=t\nOPENROUTER_API_KEY=new\n"); // stale same-key line removed (first-match-wins parsing)
  expect(mergeLegacyEnv("export OPENROUTER_API_KEY='old'\n", "OPENROUTER_API_KEY", "new"))
    .toBe("OPENROUTER_API_KEY=new\n"); // export/quote variants are recognized as the same key
  expect(mergeLegacyEnv("OTHER_A=1\n\n", "OPENROUTER_API_KEY", "k")).toBe("OTHER_A=1\nOPENROUTER_API_KEY=k\n"); // no blank pile-up
  expect(mergeLegacyEnv("OTHER_A=1", "OPENROUTER_API_KEY", "k")).toBe("OTHER_A=1\nOPENROUTER_API_KEY=k\n"); // no trailing newline
});

test("init storage wiring: writeKeyFile(keyFilePath(...)) roundtrips and resolveApiKey finds the key", () => {
  const home = tmp(), cwd = tmp();
  writeKeyFile(keyFilePath("openrouter", home), "k"); // the keyfile branch's exact call
  expect(readKeyFile(keyFilePath("openrouter", home))).toBe("k");
  expect(resolveApiKey(BACKENDS.openrouter, {}, home, cwd)).toBe("k"); // §1.4 chain resolves it
  if (process.platform !== "win32") {
    expect(fs.statSync(keyFilePath("openrouter", home)).mode & 0o777).toBe(0o600);
  }
});

test("outroLine: mentions the model in play via the chosen provider", () => {
  expect(outroLine(BACKENDS.typesafe)).toBe("Ready (jev-latest via typesafe).");
  expect(outroLine(BACKENDS.openrouter, "~typesafe/jev-1.13")).toBe("Ready (~typesafe/jev-1.13 via openrouter).");
  expect(outroLine(gatewayBackend("https://gw.example.com/v1"), "jev-latest")).toBe("Ready (jev-latest via gateway).");
});

// ---- universal skills installer (vercel-labs/skills) --------------------------

test("skillsInstallCommand: exact installer argv, path with spaces stays one argv element", () => {
  expect(skillsInstallCommand("/repo/skills"))
    .toEqual(["npx", "-y", "skills", "add", "/repo/skills", "-g", "-y"]);
  const spaced = "/Users/me/My Code/jgrep/skills";
  expect(skillsInstallCommand(spaced)).toEqual(["npx", "-y", "skills", "add", spaced, "-g", "-y"]);
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
