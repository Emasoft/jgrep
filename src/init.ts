// `jgrep init`: interactive setup. Provider -> its endpoint (compatible) or account id
// (cloudflare) when needed -> key (keep-existing or paste+verify) -> save it in
// ~/.jgrep/providers.json -> put the provider first in the fallback chain (optional) ->
// agent skills via the vercel `skills` universal installer (opt-in) -> star prompt. Every
// step is skippable with ctrl-c.
//
// TRDD-3KBUODCE: init writes ~/.jgrep/providers.json (0600 in a 0700 home, atomic) and
// nothing else. The old key stores (~/.config/jgrep/*.key, the legacy env file, ./.env) are
// still READ as fallbacks (user decision) but never written. The interactive steps stay in
// this file; the branch logic is extracted into exported pure helpers so init.test.ts can
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
import { execFile, spawnSync } from "node:child_process";
import * as p from "@clack/prompts";
import {
  BUILTINS, buildEntries, builtinDoc, isLoopbackHttp, loadProviders, providersFile, readProvidersDoc, verifyApiKey, writeFileAtomic,
  type Backend, type ProviderEntry,
} from "./providers";

// Ambient so the file typechecks without node types (same pattern as providers.ts/cli.ts);
// keep all process usage to this shape.
declare const process: { platform: string; env: Record<string, string | undefined>; exit(code: number): never };

export const REPO_URL = "https://github.com/Emasoft/jgrep";
const SKILL_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "jgrep", "SKILL.md");

// ---- wizard data + pure helpers (tested in init.test.ts) ----------------------

/** First wizard step: which built-in provider to set up. The order is the built-in chain
 *  (openrouter first, as the user decided), so the default is the chain head. */
export const PROVIDER_CHOICES: { value: string; label: string }[] = [
  { value: "openrouter", label: "OpenRouter — Jev via openrouter.ai/api/v1/systemone" },
  { value: "typesafe", label: "TypeSafe — api.typesafe.ai, the original System One provider" },
  { value: "compatible", label: "Compatible — any System One endpoint (self-hosted gateway, e.g. LiteLLM)" },
  { value: "cloudflare", label: "Cloudflare Workers AI — needs an API token and the account id" },
  { value: "vercel", label: "Vercel AI Gateway — needs an AI Gateway key" },
];

/** The compatible entry's endpoint from the full System One URL the user pastes: the origin
 *  becomes base_url and the path becomes path. Throws a plain Error with a clear message on a
 *  non-URL, a query/credential, or plain http to a remote host — the wizard re-prompts. */
export function compatibleEndpoint(url: string): { base_url: string; path: string } {
  const trimmed = url.trim();
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch {
    throw new Error(`not a valid URL: "${trimmed || "(empty)"}" — expected the full System One endpoint, e.g. https://gw.example.com/v1/systemone`);
  }
  if (parsed.protocol !== "https:" && !isLoopbackHttp(trimmed)) {
    throw new Error(`the endpoint must be https:// (or http:// on localhost), got "${trimmed}"`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("the endpoint must not hold a user name, password, query or fragment");
  return { base_url: parsed.origin, path: parsed.pathname };
}

/** Paste-prompt text per provider (pure): names where to get the key. */
export function keyPromptMessage(name: string): string {
  switch (name) {
    case "typesafe": return "Paste your TypeSafe API key (get one at https://console.typesafe.ai)";
    case "openrouter": return "Paste your OpenRouter API key (get one at https://openrouter.ai/settings/keys)";
    case "cloudflare": return "Paste your Cloudflare API token (Workers AI permission; https://dash.cloudflare.com/profile/api-tokens)";
    case "vercel": return "Paste your Vercel AI Gateway API key";
    default: return `Paste your ${name} API key (the value the endpoint expects in Authorization: Bearer)`;
  }
}

/** Confirm text when a key for the chosen provider is already resolvable. */
export function existingKeyMessage(name: string, key: string, source: string): string {
  return `A ${name} key is already configured (…${key.slice(-4)}, from ${source}). Keep it?`;
}

/** Spinner text for the verify step — names the actual host checked, never a hardcoded one. */
export function verifyHost(backend: Backend): string {
  return `Checking the key against ${new URL(backend.verify ?? backend.url).host}`;
}

/** Extra hint after a rejected key: a 404 usually means the floating model id needs
 *  an explicit version. */
export function rejectionHint(status: number): string | undefined {
  return status === 404 ? "the provider may need an explicit --model version" : undefined;
}

/** Outro: the model in play (the one the key just verified against when fresh, else
 *  the provider default) via the chosen provider. */
export function outroLine(backend: Backend, verifiedModel?: string): string {
  return `Ready (${verifiedModel ?? backend.model} via ${backend.name}).`;
}

/** Pure: `doc` with `fields` merged into the entry named `name` (appended when missing) and,
 *  with `first`, that entry moved to the front of the chain. Every other entry, and the order
 *  of the rest, stays exactly as the user wrote it (the order is their fallback chain). */
export function withEntry(doc: { version: 1; providers: ProviderEntry[] }, name: string, fields: Partial<ProviderEntry>, first = false): { version: 1; providers: ProviderEntry[] } {
  const providers = doc.providers.map((e) => ({ ...e }));
  let entry = providers.find((e) => e.name === name);
  if (!entry) { entry = { name }; providers.push(entry); }
  Object.assign(entry, fields);
  if (first) { providers.splice(providers.indexOf(entry), 1); providers.unshift(entry); }
  return { ...doc, providers };
}

/** Write providers.json (0600 in a 0700 home, temp file + rename) after validating it the way
 *  every run will read it: a file init writes must never stop the next search. Returns the path. */
export function saveProviders(doc: { version: 1; providers: ProviderEntry[] }, env: Record<string, string | undefined> = process.env, homeDir: string = os.homedir()): string {
  const file = providersFile(env, homeDir);
  buildEntries(doc, file);
  writeFileAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
  // Mode bits do not exist there: the key file is only as private as the user's profile folder.
  if (process.platform === "win32") console.error(`warning: chmod 600 is a no-op on Windows — protect ${path.dirname(file)} manually`);
  return file;
}

/** The current providers.json as a document init can edit, or every built-in by name when there
 *  is none yet (so the whole chain is visible and editable). A broken file stops init here,
 *  before any prompt: init never overwrites what it could not read. */
export function currentDoc(env: Record<string, string | undefined> = process.env, homeDir: string = os.homedir()): { doc: { version: 1; providers: ProviderEntry[] }; exists: boolean } {
  const doc = readProvidersDoc(env, homeDir);
  if (doc === null) return { doc: builtinDoc(), exists: false };
  buildEntries(doc, providersFile(env, homeDir));
  return { doc: doc as { version: 1; providers: ProviderEntry[] }, exists: true };
}

/** The vercel `skills` installer, pinned (audit: `npx -y skills` ran whatever version npm
 *  served that day — remote code at install time). Bump deliberately after a review; the
 *  dev installer (install-dev.sh SKILLS_PKG) pins the same version. */
export const SKILLS_PKG = "skills@1.7.0";

/** Argv for the vercel `skills` universal installer (github.com/vercel-labs/skills):
 *  `-g` installs to user scope (`~/<agent>/skills/`, all detected agent harnesses —
 *  Claude Code, Codex, OpenCode, Cursor, +75 more), `-y` skips every prompt. Returned
 *  as an argv array and spawned with shell:false, so a skill path containing spaces is
 *  passed through verbatim instead of being re-interpreted by a shell. */
export function skillsInstallCommand(skillDir: string): string[] {
  return ["npx", "-y", SKILLS_PKG, "add", skillDir, "-g", "-y"];
}

/** Canonical standard skills folder (`~/.agents/skills/jgrep`) — where harnesses
 *  without a dedicated directory (and the late cli, soon) look for skills. */
export function agentsSkillDir(home: string): string {
  return path.join(home, ".agents", "skills", "jgrep");
}

/** Fallback for when the universal installer can't run (no npx, offline, non-zero
 *  exit): copy the bundled SKILL.md into ~/.agents/skills/jgrep — the same mkdir-p +
 *  copy the old per-harness installSkills did, into the one standard location. */
export function installToAgentsDir(skillSrc: string, home: string): void {
  const dir = agentsSkillDir(home);
  // A symlink here (dev installs pointed it at a repo checkout) is dangling, or would make the
  // copy overwrite the repo's own SKILL.md — replace it with a real dir (upstream installSkills fix).
  // unlinkSync throws when it cannot remove the link, so the copy never goes through it.
  if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(skillSrc, path.join(dir, "SKILL.md"));
}

/** Pre-0.4 per-harness copies the old wizard wrote (~/.claude, ~/.codex); the wizard
 *  mentions them once so users can prune stale duplicates now that the universal
 *  installer manages installs. Only SKILL.md files that actually exist are listed. */
export function legacySkillCopies(home: string): string[] {
  return ["claude", "codex"]
    .map((a) => path.join(home, `.${a}`, "skills", "jgrep", "SKILL.md"))
    .filter((f) => fs.existsSync(f));
}


/** `jgrep init [--request-timeout <s>]` (review n4: the key check now honours the same
 *  per-attempt timeout flag as a search; default 15 s). */
export function parseInitArgs(argv: string[]): { requestTimeoutSec: number } {
  const o = { requestTimeoutSec: 15 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--request-timeout") {
      o.requestTimeoutSec = Number(argv[++i]);
      if (!Number.isFinite(o.requestTimeoutSec) || o.requestTimeoutSec <= 0) throw new Error("request-timeout must be a positive number");
    } else throw new Error(`unknown option ${argv[i]} for jgrep init (it takes only --request-timeout <s>)`);
  }
  return o;
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

export async function init(argv: string[] = []) {
  const { requestTimeoutSec } = parseInitArgs(argv);
  p.intro("jgrep init");
  const current = currentDoc();
  const exists = current.exists;
  let doc = current.doc;

  // 1. provider (default: the head of the built-in chain)
  const name = guard<string>(await p.select({
    message: "Which provider should jgrep use?",
    initialValue: PROVIDER_CHOICES[0].value,
    options: PROVIDER_CHOICES,
  }));
  const builtin = BUILTINS.find((b) => b.name === name)!;
  const entry = (): ProviderEntry => doc.providers.find((e) => e.name === name) ?? { name };

  // 1b. what the provider needs besides a key: compatible its endpoint, cloudflare its account id
  if (name === "compatible" && entry().base_url === undefined && !process.env.JEV_GATEWAY_URL?.trim() && !process.env.JGREP_ENDPOINT?.trim()) {
    const url = guard<string>(await p.text({
      message: "Endpoint (the full System One URL, e.g. https://gw.example.com/v1/systemone)",
      placeholder: "https://gw.example.com/v1/systemone",
      validate: (v) => {
        try { compatibleEndpoint(v ?? ""); return undefined; }
        catch (e) { return (e as Error).message; }
      },
    }));
    doc = withEntry(doc, name, compatibleEndpoint(url));
  }
  if (name === "cloudflare" && entry().account_id === undefined && !process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) {
    const id = guard<string>(await p.text({
      message: "Cloudflare account id (dash.cloudflare.com, right sidebar of any zone)",
      validate: (v) => (/^[A-Za-z0-9]{1,64}$/.test(v?.trim() ?? "") ? undefined : "1-64 letters or digits"),
    })).trim();
    doc = withEntry(doc, name, { account_id: id });
  }
  // The provider as the next run will see it, with this (unsaved) document.
  const provider = () => loadProviders(process.env, os.homedir(), ".", withEntry(doc, name, {})).providers.find((x) => x.name === name)!;

  // 2. key: keep the existing one, or paste + verify (loop with a retry confirm)
  const now = provider();
  // A local System One server (loopback http) needs no key: nothing to ask or store.
  let apiKey: string | undefined = !now.key && isLoopbackHttp(now.url) ? "" : undefined;
  if (apiKey === undefined && now.key) {
    const keep = guard<boolean>(await p.confirm({ message: existingKeyMessage(name, now.key, now.keySource), initialValue: true }));
    if (keep) apiKey = now.key;
  }
  const fresh = apiKey === undefined;
  let model: string | undefined;
  while (apiKey === undefined) {
    const typed = guard<string>(await p.password({
      message: keyPromptMessage(name),
      validate: (v) => (v?.trim() ? undefined : "The key is required: jgrep cannot run without it."),
    })).trim();
    const s = p.spinner();
    s.start(verifyHost(now));
    // verifyApiKey never throws (review m2). Only "rejected" means a bad key; an empty
    // account or an unreachable provider is not.
    const r = await verifyApiKey(now, typed, { timeoutMs: requestTimeoutSec * 1000 });
    if (r.status === "ok") { s.stop(`Key accepted (${r.model ?? name})`); apiKey = typed; model = r.model; }
    else if (r.status === "no_credits") {
      s.stop("Key accepted — but the account has no credits (HTTP 402)");
      p.log.warn(`top up ${name === "openrouter" ? "at https://openrouter.ai/credits " : ""}before searching`);
      apiKey = typed;
    } else if (r.status === "rejected") {
      s.error(`Rejected with HTTP ${r.http}${r.detail ? `: ${r.detail}` : ""}`);
      const hint = rejectionHint(r.http);
      if (hint) p.log.warn(hint);
    } else {
      s.error(`Could not verify the key (${r.http ? `HTTP ${r.http}` : r.detail ?? "network error"})`);
      const keep = guard<boolean>(await p.confirm({ message: "Save it anyway, unverified?", initialValue: true }));
      if (keep) apiKey = typed;
    }
    if (apiKey === undefined) {
      const again = guard<boolean>(await p.confirm({ message: "Try another key?", initialValue: true }));
      if (!again) bail("No working key; run `jgrep init` again later.");
    }
  }

  // 3. a new key goes into providers.json as a literal api_key (0600), unless the user exports it
  if (fresh) {
    const vars = [entry().api_key ?? builtin.api_key ?? []].flat().filter((v) => v.startsWith("$"));
    const store = vars.length === 0 || guard<boolean>(await p.confirm({
      message: `Save the key in ${providersFile()} (file mode 600)? No: you export ${vars.join(" or ")} yourself`,
      initialValue: true,
    }));
    if (store) doc = withEntry(doc, name, { api_key: apiKey });
    else p.log.info(`Not saved. Use: export ${vars[0].replace(/^\$\{?|\}$/g, "")}=…`);
  }

  // 4. the chain order: the array order is the fallback order (user decision)
  if (doc.providers[0]?.name !== name) {
    const first = guard<boolean>(await p.confirm({ message: `Put ${name} first in the fallback chain?`, initialValue: true }));
    if (first) doc = withEntry(doc, name, {}, true);
  }
  const before = exists ? JSON.stringify(readProvidersDoc()) : "";
  doc = withEntry(doc, name, {}); // the entry exists even when only its defaults are used
  if (JSON.stringify(doc) !== before) p.log.success(`Saved ${saveProviders(doc)} (mode 600)`);

  // 5. agent skills (opt-in): the vercel `skills` installer auto-detects every
  // agent-skills harness (Claude Code, Codex, OpenCode, Cursor, +75 more) and has
  // its own interactive UI — spawn with stdio:"inherit", never a clack spinner.
  // If it can't run (npx missing, offline, non-zero exit), fall back to copying the
  // bundled SKILL.md into the canonical ~/.agents/skills/jgrep standard folder.
  if (fs.existsSync(SKILL_SRC)) {
    // SKILL.md sits at <pkg>/skills/jgrep/SKILL.md: one dirname up is the skill dir,
    // two is the skills root the `skills` installer accepts as a collection.
    const skillsRoot = path.dirname(path.dirname(SKILL_SRC));
    const install = guard<boolean>(await p.confirm({
      message: "Install the jgrep skill into your AI agents? (via the vercel `skills` installer — Claude Code, Codex, OpenCode, Cursor, +75 more)",
      initialValue: true,
    }));
    if (install) {
      const [cmd, ...args] = skillsInstallCommand(skillsRoot);
      const r = spawnSync(cmd, args, { stdio: "inherit", shell: false });
      if (!r.error && r.status === 0) {
        p.log.success(`Skill installed to all detected agents (manage later with \`npx ${SKILLS_PKG} list\`).`);
      } else {
        installToAgentsDir(SKILL_SRC, os.homedir());
        p.log.warn(`fallback: copied the skill to ~/.agents/skills/jgrep (supported by late cli; run 'npx ${SKILLS_PKG} add ${skillsRoot} -g' to target specific agents)`);
      }
    }
    if (legacySkillCopies(os.homedir()).length) {
      p.log.message("note: a pre-0.4 skill copy exists in ~/.claude|~/.codex/skills/jgrep — the skills installer now manages installs; remove stale copies at will");
    }
  }

  // 6. star
  const star = guard<boolean>(await p.confirm({ message: "Enjoying jgrep? Give it a star on GitHub", initialValue: true }));
  if (star) { openUrl(REPO_URL); p.log.info(REPO_URL); }

  p.note(
    [
      `jgrep "catches an error and silently ignores it" src/`,
      `jgrep -C "validates the webhook signature" app/`,
      `jgrep --diff --staged "leaves debug output behind"`,
      "jgrep status",
    ].join("\n"),
    "Try it",
  );
  p.outro(outroLine(now, model));
}
