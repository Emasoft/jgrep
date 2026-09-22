<div align="center">

# jgrep

**grep for what code *does*, not what it's called.**

```
jgrep "catches an error and silently ignores it" src/
```

[![npm](https://img.shields.io/npm/v/jevgrep?color=0a0&label=npm)](https://www.npmjs.com/package/jevgrep)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](package.json)
[![model](https://img.shields.io/badge/powered%20by-Jev%20%C2%B7%20TypeSafe-8a2be2)](https://docs.typesafe.ai)

*No index. No embeddings. No LLM round-trips. A whole `src/` tree in ~2 s for about a cent.*

<img src="docs/demo.gif" alt="jgrep demo: semantic search over src/ and a git diff" width="900">

</div>

---

## Why

| you want to find…                          | `grep` / `rg` | embeddings | an LLM | **jgrep** |
| ------------------------------------------ | :-----------: | :--------: | :----: | :-------: |
| an exact name or string                    | ✅ instant     | meh        | 🐢 $$  | use grep  |
| "code that swallows errors"                | ❌             | ❌ fuzzy    | ✅ slow | ✅ **2 s** |
| "endpoint with no auth check" *in my diff* | ❌             | ❌          | ✅ $$   | ✅ **¢**   |
| needs an index / vector DB                 | no            | yes        | no     | **no**    |

jgrep runs on [Jev](https://docs.typesafe.ai), a *System One* model: it never
generates text, it answers typed yes/no questions with calibrated
probabilities, in parallel, at $0.042 per million input tokens with output free.
jgrep packs 16 code chunks and 16 questions into one request and turns the
probabilities into `file:line` hits.

## Install

```bash
npm i -g jevgrep     # installs the `jgrep` command
jgrep init           # pick a provider, paste your key, pick where to keep it, done
```

`jgrep init` first asks **which provider** — TypeSafe, OpenRouter, or a
self-hosted gateway — verifies the key against it, stores it with `chmod 600`,
and optionally installs the jgrep skill into your AI agents (every harness,
via the vercel `skills` installer). Get a key at
[console.typesafe.ai](https://console.typesafe.ai) or
[openrouter.ai/keys](https://openrouter.ai/keys).

Install this fork from source:

```sh
git clone https://github.com/Emasoft/jgrep && cd jgrep
bun install && bun run build
npm i -g .        # installs the `jgrep` bin from this folder, no npm release needed
```

the published `jevgrep` package on npm belongs to the upstream project — installing from source avoids any version collision with it.

<details>
<summary>Prefer not to run init?</summary>

```bash
export OPENROUTER_API_KEY=...                                            # env
echo 'OPENROUTER_API_KEY=...' >> .env                                    # per project
mkdir -p ~/.config/jgrep && echo '...' > ~/.config/jgrep/openrouter.key  # global, one file per provider
```
</details>

## Providers

Three backends speak the same Jev protocol. Pick one with `--api`, or let jgrep
find a key.

| backend      | endpoint                                                    | default model                            | key                    |
| ------------ | ----------------------------------------------------------- | ---------------------------------------- | ---------------------- |
| `typesafe`   | `https://api.typesafe.ai/v1/systemone`                      | `jev-latest`                             | `TYPESAFE_API_KEY`     |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions`                 | `~typesafe/jev-latest`                   | `OPENROUTER_API_KEY`   |
| `gateway`    | `$JEV_GATEWAY_URL` (full System One endpoint, e.g. LiteLLM) | `jev-latest` (override with `--model`)   | `JEV_GATEWAY_API_KEY`  |

Provider precedence: `--api` > `$JEV_API` > first backend with a key (typesafe
first). Key lookup, per provider: env var > `~/.config/jgrep/<name>.key` (mode
600, written by `jgrep init`) > the legacy `~/.config/jgrep/env` > `./.env` in
the project (warned on stderr when it isn't gitignored; `chmod 600` is a no-op
on Windows — init warns there too).

```bash
OPENROUTER_API_KEY=sk-or-... jgrep "swallows errors" src/   # key found, provider auto-selected
jgrep --api openrouter "swallows errors" src/               # forced
JEV_GATEWAY_URL=http://localhost:4000/systemone JEV_GATEWAY_API_KEY=... \
  jgrep --api gateway "swallows errors" src/                # any System One-speaking endpoint
```

OpenRouter's `alpha` decisions surface is the one that may move, so jgrep pings
it once before the run (`--no-probe` skips the ping). If the probe fails, pin a
version (`--model ~typesafe/jev-1.13`) or fall back to `--api typesafe`.

Note: the OpenRouter alpha decisions surface expects `choice` criteria as a
record keyed by label (not an array) — jgrep sends the record form.

Cost is the provider's reported number when it sends one (OpenRouter), else
`tokens × $JEV_PRICE_PER_MTOK` (default `$0.042` per million input tokens,
output free).

## Use

### Find code by behavior

```bash
jgrep "reads user input without validating it" app/
jgrep -C "parses a JWT or decodes a base64 token payload" src/     # -C prints the chunk
jgrep -t 0.9 "builds an SQL string by concatenation" .            # stricter
jgrep -a -t 0 "is dead code nothing calls" lib/ | head            # everything, best first
```

### Lint a change with rules written in English

```bash
jgrep --diff --staged "leaves debug output such as console.log"
jgrep --diff origin/main "adds an HTTP endpoint that has no auth check"
jgrep --diff origin/main "changes billing logic without touching a test"
```

Exit status is grep's (`0` matched, `1` nothing, `2` error or partial failure),
so CI negates it:

```yaml
- run: npm i -g jevgrep
- run: '! jgrep --diff origin/${{ github.base_ref }} "adds an HTTP endpoint that has no auth check"'
  env: { TYPESAFE_API_KEY: "${{ secrets.TYPESAFE_API_KEY }}" }
```

### Run only the tests a change can affect

```bash
jgrep --tests origin/main | xargs bun test        # or vitest / pytest / go test
jgrep --tests --staged -a                         # every test file with its probability
```

Three layers, cheapest first: tests named after a changed file (`foo.ts` → `foo.test.ts`)
and tests that import a changed module are selected in code; the rest are asked of Jev
with the compacted diff (source files only, changed lines only) and each test file's
imports and test names, one Noul per file. Default threshold is 0.5 here because a
missed test costs more than an extra one. Run the full suite afterwards; this is for the
fast first signal.

Measured on a 142-file TypeScript suite, 3 commits touching 12 source files (2026-09-21):

| | files | test cases | wall time |
| --- | ---: | ---: | ---: |
| full suite | 142 | 1,420 | 18.9 s |
| `jgrep --tests HEAD~3` | 47 (12 by name, 27 by import, 8 by Jev) | 536 | 12.6 s |

Selection itself: 7 requests, 56k tokens, $0.0024, 1.0 s. The suite above is fast, so
runner startup dominates; the ratio matters more on suites that take minutes.

### Score a table (CSV / JSONL), not just code

Every row becomes one state. One description works like grep; a JSON file of
Jev questions (noul, choice, score) adds one answer column per question.

```bash
jgrep --rows creators.csv "beauty is the main content of this account"
jgrep --rows creators.csv --questions beauty.json --out scored.csv
```

```json
{
  "beauty":   { "type": "noul",   "instructions": "Is beauty the main content of this account?" },
  "category": { "type": "choice", "instructions": "Dominant sub-category?",
                "criteria": { "skincare": "skin care", "makeup": "cosmetics", "other": "not beauty" } },
  "fit":      { "type": "score",  "instructions": "Fit for a Korean skincare seeding campaign?",
                "criteria": ["no fit", "weak", "moderate", "strong", "ideal"] }
}
```

Question objects are passed to the API verbatim, so anything Jev accepts works.
Output columns: `beauty` (probability), `category` + `category_p`, `fit` + `fit_conf`.
Eight creators and five questions is one request, 3k tokens, well under a cent;
see [`examples/`](examples/). This is the "AI map-reduce" shape: scrape N
things, ask k typed questions each, filter in a spreadsheet.

### Feed your coding agent

Agents burn most of their tokens *looking* for code. jgrep hands them a short
list of ranges instead of whole files. On a 115 KB module the agent read
6 KB of matching chunks instead of everything.

```bash
jgrep init                   # offers installing the skill into your AI agents
jgrep --json "spawns a child process" src/ | jq '.[].file'             # bare array (v0.3.0 shape)
jgrep --json-errors "spawns a child process" src/ | jq '.hits[].file'  # opt-in object, errors included
```

`jgrep init` installs the skill into every agent-skills harness (Claude Code,
Codex, OpenCode, Cursor, +75 more) via the vercel `skills` installer, falling
back to the standard `~/.agents/skills/jgrep` folder. Manually:
`npx skills add <pkg-root>/skills -g` (from a repo checkout: `npx skills add ./skills -g`).

The skill also has the agent run a few `--diff --staged` rules on its own
change before committing: a second model checking the first one's work, for
a fraction of a cent.

## Reliability

Failures are isolated by default: a failed batch marks only its chunks errored,
the rest of the run continues, and answers already paid for are kept in the
cache.

- **Retries**: statuses 408/429/500/502/503/504/529 and transport errors
  (timeouts, `ECONNRESET`/`ETIMEDOUT`/`ECONNREFUSED`/`EAI_AGAIN`) retry with
  full-jitter exponential backoff (500 ms base, 30 s cap), `--retries` times
  (default 4, so 5 attempts). A provider `Retry-After` is honored, capped at
  5 minutes.
- **Deadlines**: `--request-timeout` (30 s) bounds one HTTP attempt;
  `--timeout` (15 s) is the deadline for a whole batch *including* its retries —
  an expired batch is recorded as errored and the run moves on.
- **Pacing**: `--rate REQ/SEC` spaces all requests with a token bucket
  (0 = unlimited).
- **Circuit breaker**: 3 consecutive fatal failures — out of credits, bad key,
  model gone, host unreachable, TLS — abort the run instead of hammering on;
  chunks never attempted are reported as `circuit_breaker_open`. `--fail-fast`
  restores abort-on-the-first-fatal.

## Errors & exit codes

Exit status: `0` hits, `1` none, `2` when any chunk errored or a fatal was
thrown. Hits and the error breakdown are both printed, and every failed chunk
carries a typed kind with a hint on stderr:

| kind                   | hint |
| ---------------------- | ---- |
| `insufficient_credits` | billing URL to top up, or `--api typesafe` if a TypeSafe key exists |
| `invalid_api_key`      | names the provider's key env and key file; tells you when the key worked earlier this run (expired/revoked) vs never worked (wrong provider's key) |
| `model_unavailable`    | pin a version with `--model` (e.g. `typesafe/jev-1.13`), or `--api typesafe` |
| `rate_limited`         | the provider is throttling — pace with `--rate` |
| `bad_request`          | request-shape problem; the provider's response body is quoted |
| `malformed_response`   | the API surface may have changed — pin `--model` or report it |
| `server_unreachable`   | check the network or the provider's status page |
| `tls_error`            | certificate problem, message quoted verbatim |
| `timeout`              | raise `--timeout` or `--request-timeout` |
| `circuit_breaker_open` | provider failing consistently — the chunk was never attempted |

**`--json` is backward-compatible**: code mode is byte-identical to 0.3.0
(`[{file,start,end,p,text}]`); rows mode is a flattened answer array with
`null` for an errored row (position-aligned, so index `i` is
always input row `i`). Errored chunks/rows are not in the array; they surface
through the stderr summary and exit 2. New in 0.4.0: **`--json-errors`**
(implies `--json`) opts into the object shape — code mode
`{"hits":[…],"errors":[{file,start,end,kind,message}]}`, rows mode
`{"answers":[…],"errors":[{row,kind,message}]}`. `--out` writes whichever
shape was selected.

Two cache notes. Keys now include the resolved model id, so entries for another
provider's model — openrouter's `~typesafe/jev-latest`, any `--model` override —
are separate from typesafe's `jev-latest`: those queries re-bill once on the
first run after upgrading, default typesafe queries keep their old keys. And a
failed batch is retried as a whole: keeping per-answer results from a failed
batch depends on the provider returning per-question answers alongside errors,
which is still to be verified on the OpenRouter alpha surface.

## All options

```
jgrep init                               interactive setup (provider, key, agent skills)
jgrep [options] "<description>" [path ...]
jgrep [options] --diff [ref] "<description>"
jgrep [options] --rows <file.csv|.jsonl> "<description>"
jgrep [options] --rows <file> --questions <q.json> [--out scored.csv]
jgrep [options] --tests [ref] [--staged] [path ...]

  -t, --threshold <p>   print chunks with probability >= p (default 0.7)
  -C, --show            print the matching chunk body under each hit
  -a, --all             print every chunk with its probability, best first
      --json            machine-readable output: hits as a JSON array
                        (v0.3.0-compatible: [{file,start,end,p,text}]; rows:
                        [flattened answer objects, null for errored rows])
      --json-errors     with --json: a JSON object instead — code mode
                        {hits:[...], errors:[{file,start,end,kind,message}]};
                        rows mode {answers:[...], errors:[{row,kind,message}]}
      --diff [ref]      grep git diff hunks instead of files
                        (working tree by default, or against <ref>)
      --staged          with --diff / --tests: staged changes only
      --tests [ref]     predictive test selection: print the test files a diff
                        plausibly affects (working tree, or against <ref>);
                        pipe into your runner:  bun test $(jgrep --tests origin/main)
      --rows <file>     grep rows of a CSV / JSONL file instead of code
      --questions <f>   with --rows: JSON of Jev questions (noul/choice/score)
                        asked of every row; prints the table with answer columns
      --out <file>      with --questions: write the CSV here instead of stdout
                        (with --json: the JSON output goes to the file)
  -b, --batch <n>       chunks per request (default 16)
  -c, --concurrency <n> parallel requests (default 16)
      --api <name>      provider: typesafe | openrouter | gateway
                        precedence: --api > $JEV_API > first key found (typesafe first)
      --model <id>      model id override (default: the provider's default; or $JEV_MODEL)
      --timeout <s>     per-batch deadline, retries included (default 15)
      --request-timeout <s>  per-attempt HTTP timeout (default 30)
      --retries <n>     failed attempts tolerated per batch (default 4)
      --rate <req/s>    global request pacing (token bucket); 0 = unlimited
      --fail-fast       abort on the first fatal error instead of isolating it
      --no-probe        skip the openrouter startup probe
      --no-cache        ignore and do not write ~/.cache/jgrep
  -v, --version         print version
```

## How it works

1. **Files** come from `git ls-files` (untracked included, ignored excluded),
   or a directory walk. Binaries and files over 1 MB are skipped.
2. **Chunks**: each file is split at column-0 line starts into 5 to 60 line
   pieces. Markdown files (`.md`/`.mdx`) are split at their headings instead,
   each chunk carrying its section trail (`jgrep > Help`) as context, and fenced
   code blocks are never split. With `--diff`, each hunk is a chunk and keeps
   its `+`/`-` markers.
3. **One request, 16 chunks, 16 questions**: `state.chunks[]` plus a Noul
   question per chunk, *"look only at chunk c3, does it match: …"*.
4. **Threshold**: probabilities at or above `-t` are printed in file order.
   Answers are cached by `(model, question, chunk)` in `~/.cache/jgrep/`, so
   the same query again is free and instant.

| repo                         | chunks | time  | cost    |
| ---------------------------- | -----: | ----: | ------: |
| TypeScript CLI, `src/`       |    896 | 1.8 s | $0.010  |
| same query again (cache)     |    896 | 0.0 s | $0      |
| one module, `app/lib/`       |    521 | 1.6 s | $0.006  |

## Accuracy

How reliable is the matching? A benchmark harness — labeled fixtures (SMS spam,
AG News, hand-written code-selection cases) plus an accuracy runner — lives
under `bench/`, with the fixtures committed so every run is reproducible.
Latest results:

| benchmark              |   n | accuracy | macro-F1 |
| ---------------------- | --: | -------: | -------: |
| SMS spam vs ham        | 200 |     0.95 |     0.95 |
| AG News (4-way)        | 120 |     0.84 |     0.84 |
| Code selection (top-1) |  20 |     1.00 |        — |

Numbers above are **one provider's run** — OpenRouter, model
`~typesafe/jev-latest` — on 2026-09-20 at commit `1b3a4f9`, not a
cross-provider average. The bench runs **on demand** via the Bench workflow
(`workflow_dispatch`); TypeSafe numbers land here after the first CI bench run.

```bash
bun bench/accuracy.ts --fixture sms --limit 20   # precision/recall on 20 rows per class
```

## Tips

- Write the description in **English** and describe the **code**, not the
  feature: *"decides whether to alert based on OCR confidence"* beats
  *"alert feature"*. Jev's accuracy is lower on non-English text.
- One behavior per query. Split compound questions and combine in your head
  (or in a script with `--json`).
- Chunks are judged in isolation, so cross-file flow ("does this eventually
  hit the DB") will not match. Ask about the local code.
- `p >= 0.9` is reliable, `0.7-0.9` is worth a look.

## Develop

```bash
bun test src/     # unit tests, no network
bun run build     # dist/jgrep.js, plain node, deps bundled
```

### Live e2e (opt-in)

`src/e2e.live.test.ts` exercises the real OpenRouter path: 4 live calls — a
behavioral code query, a rows classification, the invalid-key error taxonomy,
and the key probe — costing about **$0.005** per full run.

```bash
JGREP_E2E_LIVE=1 bun test src/e2e.live.test.ts   # needs OPENROUTER_API_KEY
```

It never runs in CI: the suite is double-gated on the opt-in `JGREP_E2E_LIVE=1`
env var AND on `CI` being unset (GitHub Actions always sets `CI`), so no CI run
can trigger spend. Without the flag, `bun test` reports these tests as skipped.

### install-dev.sh (dev only)

`install-dev.sh` is strictly a development installer for this checkout —
it installs, inspects, and uninstalls every flavor of the `jgrep` bin.
**End users should not use it: install via npm (`npm i -g jevgrep`).**
It is never shipped in the npm package.

Interactive menu (stable numbering — never renumbered):

```text
[1] local dev (symlink)   build current branch, symlink <target>/jgrep -> <repo>/dist/jgrep.js
[2] local pinned (copy)   build current branch, copy snapshot
[3] fork main (copy)      build origin/main, copy         (fetch + git worktree in a tmpdir)
[4] upstream main (copy)  build upstream/main, copy       (fetch + git worktree in a tmpdir)
[5] npm stable            npm install -g jevgrep (upstream's published release)
[6] check only            autodetect report, no mutation
[7] uninstall jgrep       remove every detected install (npm/symlink/copy/brew-aware)
[q] quit
```

Before the menu a `current:` line reports the detected install (type, path,
version) and the matching option is marked `[CURRENT]`; multiple installs
produce an explicit warning. Options that cannot run right now (bun missing,
remote mispointed) are shown as `[unavailable: …]` instead of `[AVAILABLE]`.

Headless / unattended mode — `--choice N` (or a bare `N`) runs one option with
zero prompts, everything auto-confirmed and deterministic exit codes;
`./install-dev.sh uninstall` is an alias for `--choice 7`; `--dry-run` prints
the would-be commands and mutates nothing; `--target DIR` installs into `DIR`
instead of the default chain (`$(npm prefix -g)/bin` → `/usr/local/bin` →
`~/.local/bin`); `check` prints the full autodetect report:

```sh
./install-dev.sh --choice 1            # build current branch + symlink, zero prompts
./install-dev.sh --choice 7 --dry-run  # preview the uninstall
./install-dev.sh check                 # full report, no mutation
```

Fool-proofing, by design:

- **Identity-verified npm package** — before any `npm install`/`npm uninstall`
  the script verifies that `jevgrep` really is this project's package
  (`repository.url` must point at `github.com/kyu1204/jgrep`). npm also hosts
  an **unrelated** `jgrep` package ("Recursive grep."), and the name collides
  across GitHub — if `jevgrep` ever stops pointing at kyu1204/jgrep (takeover,
  hijack, registry mix-up) the script refuses loudly instead of installing or
  removing the wrong thing. No override. Options 3/4 verify the `origin`/
  `upstream` git remotes the same way; options 1/2 verify the checkout's
  `package.json` name.
- **Refuses to remove files that are not jgrep** — uninstall proves each entry
  (`--version`) before touching it, archives real files as `.bak` with a
  revert hint, never deletes the repo's `dist/jgrep.js` through a symlink, and
  leaves brew-owned files to `brew`.
- **Idempotent** — installing the same build again is a no-op ("already up to
  date"), and uninstalling with nothing installed prints "jgrep is not
  installed — nothing to do" and exits 0.
- **Agent-skill auto-refresh** — after a local install ([1]/[2]/[3]) the agent
  skill (`skills/jgrep/SKILL.md`) is refreshed too: the vercel `skills`
  installer (`npx -y skills add ./skills -g -y`) updates every detected
  harness, falling back to `~/.agents/skills/jgrep` when the installer fails
  or is offline. Without this a dev-folder install would leave AI harnesses
  quoting stale flags (the skill embeds a verbatim copy of `jgrep --help`).
  Upstream-source installs ([4]) skip the refresh (no skill in that tree), and
  the refresh is best-effort — it never fails the install. The manual
  alternative is unchanged: `npx skills add ./skills -g`.

The menu numbers are a stable contract: they will never be renumbered.

If jgrep saved you a file-hunting session, a ⭐ on GitHub is the best thanks.

MIT
