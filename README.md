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
jgrep --json "spawns a child process" src/ | jq '.hits[].file'
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

**Breaking in 0.4.0:** `--json` is an object now —
`{"hits":[…],"errors":[{file,start,end,kind,message}]}` (rows mode:
`{"answers":[…],"errors":[{row,kind,message}]}`); it was a bare array.

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

  -t, --threshold <p>   print chunks with probability >= p (default 0.7)
  -C, --show            print the matching chunk body under each hit
  -a, --all             print every chunk with its probability, best first
      --json            machine-readable output: {"hits":[...],"errors":[...]}
                        rows mode: {"answers":[...],"errors":[...]}
                        (v0.4 breaking change: was a bare array; errors carry
                        {file,start,end,kind,message} / rows {row,kind,message})
      --diff [ref]      grep git diff hunks instead of files
                        (working tree by default, or against <ref>)
      --staged          with --diff: staged changes only
      --rows <file>     grep rows of a CSV / JSONL file instead of code
      --questions <f>   with --rows: JSON of Jev questions (noul/choice/score)
                        asked of every row; prints the table with answer columns
      --out <file>      with --questions: write the CSV here instead of stdout
                        (with --json: the JSON object goes to the file)
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
   pieces. With `--diff`, each hunk is a chunk and keeps its `+`/`-` markers.
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
bun bench/accuracy.ts --fixture sms --limit 20   # precision/recall on 20 labeled rows
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

If jgrep saved you a file-hunting session, a ⭐ on GitHub is the best thanks.

MIT
