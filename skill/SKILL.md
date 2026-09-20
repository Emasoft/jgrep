---
name: jgrep
description: >-
  Semantic grep for code. Use `jgrep` when you need to locate code by what it
  DOES rather than by an identifier you already know ("where do we retry
  failed requests", "code that swallows errors", "anything that shells out"),
  before opening many files to look for something, and as a cheap self-check
  of your own diff before committing. Returns file:line ranges with a
  probability, in about 2 seconds for a whole src/ tree. Keep using plain
  grep/rg for exact names and strings.
---

# jgrep

`jgrep "<description in English>" [paths]` asks a fast decision model (Jev, via
TypeSafe by default — OpenRouter and a self-hosted gateway also speak the
protocol) one yes/no question per 5-60 line chunk and prints the chunks that
match. It never reads files into your context: you get a short list, then you
Read only the ranges you need.

## When to use it instead of grep or reading files

- You know the behavior, not the name: "validates the webhook signature",
  "builds the SQL string by concatenation", "catches and ignores errors".
- You would otherwise open 5+ files hunting for something.
- You want a second opinion on your own change: run it on the diff.

Do not use it for exact identifiers, strings, or paths. `rg` is free and instant.

## Commands

```
jgrep "description" src/                 # hits with p >= 0.7, file order
jgrep -t 0.85 "description" src/         # fewer, higher-precision hits
jgrep -C "description" src/              # print the matching chunk bodies
jgrep --json "description" src/          # {"hits":[{file,start,end,p,text}],"errors":[...]}
jgrep -a -t 0 "description" src/ | head  # everything, best first (when 0 hits)
jgrep --diff --staged "rule"             # lint your staged change
jgrep --diff origin/main "rule"          # lint the branch against main
jgrep --api openrouter "rule" src/       # pick a provider: typesafe | openrouter | gateway
```

Exit status: 0 hits found, 1 none, 2 on error or when any chunk errored
(partial failure: hits and the error breakdown are both reported; every failed
chunk carries a typed kind). Every run prints a summary line on stderr:
`N hits / M chunks · tokens · $cost · seconds`, with `· K errored (kinds)`
appended when chunks failed.

Reliability: retries use full-jitter backoff (`--retries`, default 4);
`--timeout` bounds each batch including retries, `--request-timeout` each
attempt; `--rate REQ/SEC` paces requests. A circuit breaker aborts after 3
consecutive fatal failures (`--fail-fast` restores abort-on-the-first);
`--no-probe` skips the openrouter startup ping.

## Reading results

```
src/loop/state.ts:108-115  p=0.96  export function readRun(...)
```

`p` is the probability the chunk matches. Treat >= 0.9 as reliable, 0.7-0.9
as worth a look, below 0.5 as no. After a run, Read only the listed ranges
(`offset`/`limit`), not whole files.

## Writing the description

- English, one concrete behavior per query. Split compound questions.
- Describe the code, not the feature name: "decides whether to send an
  alert based on OCR confidence" beats "alert feature".
- Chunks are 5-60 lines seen in isolation, so cross-file flow ("does this
  eventually write to the DB") will not match; ask about the local code.

## Self-review before committing

Run 2-4 rules on the staged diff; each rule is one sentence about a mistake
you might have made. Exit 0 means a hit, so investigate those chunks.

```
jgrep --diff --staged "leaves debug output such as console.log or print"
jgrep --diff --staged "changes behavior without a corresponding test change"
jgrep --diff --staged "adds an endpoint or handler with no input validation"
```

## Tables, not code

`jgrep --rows data.csv "<description>"` treats every row as a chunk and prints
matching rows. With `--questions q.json` (a JSON object of Jev questions:
`{name: {type: noul|choice|score, instructions, criteria?}}`) it writes the
table back with one answer column per question (`--out scored.csv` or
`--json`). Use it to label, triage or filter a list of records instead of
reading them one by one.

## Requirements

Installed globally as `jgrep`; the key lives in `~/.config/jgrep/<provider>.key`
(or the legacy `~/.config/jgrep/env`), with the provider's env var looked up
first. If it reports "No <provider> API key found. Looked in: …", tell the user
rather than working around it. Run it inside a project directory or pass the
project path: it refuses to walk a non-git directory with more than 5000 files.
