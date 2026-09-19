#!/usr/bin/env node
import { chunkPaths, diffChunks, gitDiff, jgrep, loadCache, saveCache, resolveApiKey, USD_PER_M_INPUT, type Hit, type Kind } from "./jgrep";

const VERSION = "0.2.0";
const USAGE = `jgrep ${VERSION} — semantic grep powered by Jev (TypeSafe)

usage: jgrep init                       interactive setup (API key, agent skills)
       jgrep [options] "<description>" [path ...]
       jgrep [options] --diff [ref] "<description>"

  -t, --threshold <p>   print chunks with probability >= p (default 0.7)
  -C, --show            print the matching chunk body under each hit
  -a, --all             print every chunk with its probability, best first
      --json            machine-readable output
      --diff [ref]      grep git diff hunks instead of files
                        (working tree by default, or against <ref>)
      --staged          with --diff: staged changes only
  -b, --batch <n>       chunks per request (default 16)
  -c, --concurrency <n> parallel requests (default 16)
      --no-cache        ignore and do not write ~/.cache/jgrep
  -v, --version         print version

exit status: 0 when something matched, 1 when nothing did, 2 on error.
CI lint:    ! jgrep --diff origin/main "adds an endpoint without an auth check"

examples:
  jgrep "catches an error and silently ignores it" src/
  jgrep -C "reads user input without validating it" app/
  jgrep --diff --staged "changes billing logic without touching tests"`;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

export function parse(argv: string[]) {
  const o = { threshold: 0.7, batch: 16, concurrency: 16, all: false, show: false, json: false, cache: true, diff: null as string[] | null };
  const rest: string[] = [];
  const positionalsAfter = (i: number) => argv.slice(i + 1).filter((x) => !x.startsWith("-")).length;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-t" || a === "--threshold") o.threshold = Number(argv[++i]);
    else if (a === "-b" || a === "--batch") o.batch = Number(argv[++i]);
    else if (a === "-c" || a === "--concurrency") o.concurrency = Number(argv[++i]);
    else if (a === "-a" || a === "--all") o.all = true;
    else if (a === "-C" || a === "--show") o.show = true;
    else if (a === "--json") o.json = true;
    else if (a === "--no-cache") o.cache = false;
    else if (a === "--staged") (o.diff ??= []).push("--staged");
    else if (a === "--diff") {
      o.diff ??= [];
      // `--diff <ref>` when a ref follows and the question is still available elsewhere
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && (rest.length > 0 || positionalsAfter(i + 1) > 0)) o.diff.push(argv[++i]);
    }
    else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
    else if (a === "-V" || a === "-v" || a === "--version") { console.log(VERSION); process.exit(0); }
    else if (a.startsWith("-") && a !== "-") throw new Error(`unknown option ${a} (try --help)`);
    else rest.push(a);
  }
  if (![o.threshold, o.batch, o.concurrency].every((n) => Number.isFinite(n) && n >= 0)) throw new Error("numeric option expected");
  return { ...o, question: rest[0], paths: rest.slice(1) };
}

async function main() {
  if (process.argv[2] === "init") { const { init } = await import("./init"); return init(); }
  const o = parse(process.argv.slice(2));
  if (!o.question) { console.error(USAGE); process.exit(2); }
  const t0 = Date.now();
  const kind: Kind = o.diff ? "diff" : "code";
  const chunks = o.diff ? diffChunks(gitDiff(o.diff)) : chunkPaths(o.paths.length ? o.paths : ["."]);
  if (!chunks.length) { console.error(o.diff ? "empty diff" : "no text files found"); process.exit(1); }
  const cache = o.cache ? loadCache() : {};
  const r = await jgrep(o.question, chunks, {
    ...o, kind, apiKey: resolveApiKey(), cache,
    onProgress: (d, n) => { if (process.stderr.isTTY) process.stderr.write(`\r${d}/${n} requests`); },
  });
  if (o.cache) saveCache(cache);
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");

  const rows: Hit[] = o.all ? [...r.all].sort((a, b) => b.p - a.p) : r.hits;
  if (o.json) {
    console.log(JSON.stringify(rows.map((h) => ({ file: h.file, start: h.start, end: h.end, p: h.p, text: h.text })), null, 2));
  } else {
    for (const h of rows) {
      const head = h.text.split("\n").find((l) => l.trim() && !l.startsWith("@@"))?.trim().slice(0, 90) ?? "";
      const pcol = h.p >= o.threshold ? "32" : "90";
      console.log(`${c("35", h.file)}${c("36", ":")}${c("32", `${h.start}-${h.end}`)}  ${c(pcol, `p=${h.p.toFixed(2)}`)}  ${head}`);
      if (o.show) console.log(h.text.split("\n").map((l) => "    " + l).join("\n") + "\n");
    }
  }
  const cost = (r.tokens * USD_PER_M_INPUT) / 1e6;
  console.error(c("90", `${r.hits.length} hits / ${r.chunks} chunks (${r.cached} cached) · ${r.tokens} tokens · $${cost.toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`));
  process.exit(r.hits.length ? 0 : 1);
}

if (!process.env.JGREP_NO_MAIN) main().catch((e) => { console.error(c("31", e.message)); process.exit(2); });
