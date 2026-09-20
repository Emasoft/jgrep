// `jgrep init`: interactive setup. Provider -> gateway URL (gateway only) -> key
// (keep-existing or paste+verify) -> where to store -> agent skills (opt-in) ->
// star prompt. Every step is skippable with ctrl-c.
//
// Step 8: per-provider key setup. The wizard provisions any of the three backends
// (typesafe / openrouter / gateway) instead of assuming TypeSafe. The interactive
// steps stay in this file; the branch logic is extracted into exported pure
// helpers (gatewayBackend, keyPromptMessage, storageLine, ...) so init.test.ts can
// cover every branch without mocking @clack.
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo; the surface used is trivial
import fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import path from "node:path";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import { fileURLToPath } from "node:url";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import { execFile } from "node:child_process";
import * as p from "@clack/prompts";
import { installSkills } from "./jgrep";
import {
  BACKENDS, PROVIDER_URLS, keyFilePath, legacyEnvFile, resolveApiKey, verifyApiKey,
  writeKeyFile, type Backend,
} from "./providers";

// Ambient so the file typechecks without node types (same pattern as providers.ts/cli.ts);
// keep all process usage to this shape.
declare const process: { platform: string; exit(code: number): never };

export const REPO_URL = "https://github.com/Emasoft/jgrep";
const SKILL_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skill", "SKILL.md");

// ---- wizard data + pure helpers (tested in init.test.ts) ----------------------

/** First wizard step: which System One-speaking provider to provision (default typesafe). */
export const PROVIDER_CHOICES: { value: Backend["name"]; label: string }[] = [
  { value: "typesafe", label: "TypeSafe — api.typesafe.ai, the original System One provider" },
  { value: "openrouter", label: "OpenRouter — same Jev protocol via openrouter.ai/api/alpha/decisions" },
  { value: "gateway", label: "Self-hosted gateway — any System One endpoint (e.g. LiteLLM)" },
];

/** Validated gateway backend: a copy of BACKENDS.gateway with `url` set. Throws a plain
 *  Error with a clear message on a non-URL or non-http(s) value — the wizard re-prompts. */
export function gatewayBackend(url: string): Backend {
  const trimmed = url.trim();
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch {
    throw new Error(`not a valid URL: "${trimmed || "(empty)"}" — expected the full System One endpoint, e.g. https://gw.example.com/v1/systemone`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`the gateway URL must be http(s), got "${parsed.protocol}"`);
  }
  return { ...BACKENDS.gateway, url: trimmed };
}

/** Paste-prompt text per provider (pure): names where to get the key. */
export function keyPromptMessage(backend: Backend): string {
  switch (backend.name) {
    case "typesafe": return `Paste your TypeSafe API key (get one at ${PROVIDER_URLS.typesafe.console})`;
    case "openrouter": return "Paste your OpenRouter API key (get one at https://openrouter.ai/keys)";
    case "gateway": return "Paste your gateway API key (or the value your gateway expects in Authorization: Bearer)";
  }
}

/** Confirm text when a key for the chosen provider is already resolvable. */
export function existingKeyMessage(backend: Backend, key: string): string {
  return `A ${backend.name} key is already configured (…${key.slice(-4)}). Keep it?`;
}

/** Spinner text for the verify step — names the actual backend host, never a hardcoded one. */
export function verifyHost(backend: Backend): string {
  return `Checking the key against ${new URL(backend.url).host}`;
}

/** Extra hint after a rejected key: a 404 on the alpha surface usually means the
 *  floating model id needs an explicit version. */
export function rejectionHint(status: number): string | undefined {
  return status === 404 ? "the alpha surface may need an explicit --model version" : undefined;
}

/** Storage choices for a NEW key; the first entry is the select's default. */
export type StorageChoice = "keyfile" | "legacy" | "project" | "none";

export function storageOptions(backend: Backend): { value: StorageChoice; label: string; hint?: string }[] {
  return [
    { value: "keyfile", label: keyFilePath(backend.name), hint: "recommended: per-provider file, mode 600" },
    { value: "legacy", label: legacyEnvFile(), hint: "legacy global env file, works in every project" },
    { value: "project", label: "./.env in this directory", hint: "add .env to .gitignore" },
    { value: "none", label: "Don't save", hint: `I'll export ${backend.keyEnv} myself` },
  ];
}

/** "Where the key went" human summary per storage choice (pure; init logs it after the IO). */
export function storageLine(backend: Backend, choice: string, homeDir: string = os.homedir()): string {
  switch (choice) {
    case "keyfile": return `Saved to ${keyFilePath(backend.name, homeDir)} (mode 600)`;
    case "legacy": return `Saved to ${legacyEnvFile(homeDir)} (${backend.keyEnv}, mode 600)`;
    case "project": return `Appended ${backend.keyEnv} to ./.env`;
    case "none":
    default: return `Not saved. Use: export ${backend.keyEnv}=…`;
  }
}

/** Outro: the model in play (the one the key just verified against when fresh, else
 *  the backend default) via the chosen provider. */
export function outroLine(backend: Backend, verifiedModel?: string): string {
  return `Ready (${verifiedModel ?? backend.model} via ${backend.name}).`;
}

/** Pure: next content of the legacy ~/.config/jgrep/env — drop any stale line for
 *  keyEnv (first-match-wins parsing would otherwise resurrect an old key on a
 *  re-run), keep every other line (other providers' entries survive), append
 *  `KEYENV=<key>`. Tolerates `export `/quotes like the parser in providers.ts. */
export function mergeLegacyEnv(existing: string | null, keyEnv: string, key: string): string {
  const kept = (existing ?? "").split(/\r?\n/).filter((l) => {
    const m = /^\s*(?:export\s+)?([\w.]+)\s*=/.exec(l);
    return m?.[1] !== keyEnv;
  });
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop(); // no blank-line pile-up
  return [...kept, `${keyEnv}=${key}`].join("\n") + "\n";
}

// ---- wizard plumbing ----------------------------------------------------------

// Legacy global storage (~/.config/jgrep/env, `KEYENV=<key>`): the file+format the
// pre-0.4 wizard wrote, preserved so existing installs keep working. Step 8
// generalizes it to any provider's keyEnv; mergeLegacyEnv does the content math.
function saveLegacyEnvKey(keyEnv: string, key: string): string {
  const file = legacyEnvFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let existing: string | null = null;
  try { existing = fs.readFileSync(file, "utf8"); } catch { /* new file */ }
  fs.writeFileSync(file, mergeLegacyEnv(existing, keyEnv, key), { mode: 0o600 });
  return file;
}

function bail(msg = "Setup cancelled."): never {
  p.cancel(msg);
  process.exit(1);
}
const guard = <T,>(v: T | symbol): T => (p.isCancel(v) ? bail() : (v as T));

function openUrl(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, () => { /* best effort; the URL is printed anyway */ });
}

export async function init() {
  p.intro("jgrep init");

  // 1. provider (new first step — any of the three backends can be provisioned)
  const provider = guard<Backend["name"]>(await p.select({
    message: "Which provider should jgrep use?",
    initialValue: "typesafe",
    options: PROVIDER_CHOICES,
  }));
  let backend: Backend = { ...BACKENDS[provider] };
  if (provider === "gateway") {
    // gateway needs the full System One endpoint; clack re-prompts on a validate error
    const url = guard<string>(await p.text({
      message: "Gateway URL (the full System One endpoint, e.g. https://gw.example.com/v1/systemone)",
      placeholder: "https://gw.example.com/v1/systemone",
      validate: (v) => {
        try { gatewayBackend(v ?? ""); return undefined; }
        catch (e) { return (e as Error).message; }
      },
    })).trim();
    backend = gatewayBackend(url);
  }

  // 2. key: keep the existing one, or paste + verify (loop with a retry confirm)
  let existing: string | undefined;
  try { existing = resolveApiKey(backend); } catch { /* none — expected */ }
  if (existing) {
    const keep = guard<boolean>(await p.confirm({
      message: existingKeyMessage(backend, existing),
      initialValue: true,
    }));
    if (!keep) existing = undefined;
  }

  let apiKey = existing;
  let model: string | undefined;
  while (!apiKey) {
    const typed = guard<string>(await p.password({
      message: keyPromptMessage(backend),
      validate: (v) => (v?.trim() ? undefined : "The key is required: jgrep cannot run without it."),
    })).trim();
    const s = p.spinner();
    s.start(verifyHost(backend));
    try {
      const r = await verifyApiKey(backend, typed);
      if (r.ok) { s.stop(`Key accepted (${r.model ?? "jev"})`); apiKey = typed; model = r.model; }
      else {
        s.error(`Rejected with HTTP ${r.status}`);
        const hint = rejectionHint(r.status);
        if (hint) p.log.warn(hint);
      }
    } catch (e) {
      s.error(`Could not reach the API: ${(e as Error).message}`);
    }
    if (!apiKey) {
      const again = guard<boolean>(await p.confirm({ message: "Try another key?", initialValue: true }));
      if (!again) bail("No working key; run `jgrep init` again later.");
    }
  }

  // 3. where to store (only when the key is new)
  if (!existing) {
    const where = guard<StorageChoice>(await p.select({
      message: "Where should the key live?",
      initialValue: "keyfile",
      options: storageOptions(backend),
    }));
    if (where === "keyfile") writeKeyFile(keyFilePath(backend.name), apiKey); // 0600; Windows chmod warning inside
    else if (where === "legacy") saveLegacyEnvKey(backend.keyEnv, apiKey);
    else if (where === "project") fs.appendFileSync(".env", `${backend.keyEnv}=${apiKey}\n`);
    if (where === "none") p.log.info(storageLine(backend, where));
    else p.log.success(storageLine(backend, where));
    if (where === "project" && (!fs.existsSync(".gitignore") || !fs.readFileSync(".gitignore", "utf8").split("\n").includes(".env"))) {
      p.log.warn(".env is not in .gitignore");
    }
  }

  // 4. agent skills (opt-in)
  const agents = [
    { value: "claude", label: "Claude Code", hint: "~/.claude/skills/jgrep" },
    { value: "codex", label: "Codex", hint: "~/.codex/skills/jgrep" },
  ].filter((a) => fs.existsSync(path.join(os.homedir(), `.${a.value}`)));
  if (agents.length && fs.existsSync(SKILL_SRC)) {
    const picked = guard<string[]>(await p.multiselect({
      message: "Teach your coding agents to use jgrep? (space to toggle, enter to continue)",
      options: agents,
      required: false,
    }));
    if (picked.length) {
      for (const dir of installSkills(SKILL_SRC, os.homedir(), picked)) p.log.success(`Skill installed: ${dir}`);
    }
  }

  // 5. star
  const star = guard<boolean>(await p.confirm({ message: "Enjoying jgrep? Give it a star on GitHub", initialValue: true }));
  if (star) { openUrl(REPO_URL); p.log.info(REPO_URL); }

  p.note(
    [
      `jgrep "catches an error and silently ignores it" src/`,
      `jgrep -C "validates the webhook signature" app/`,
      `jgrep --diff --staged "leaves debug output behind"`,
    ].join("\n"),
    "Try it",
  );
  p.outro(outroLine(backend, model));
}
