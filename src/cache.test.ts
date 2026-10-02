// WI-6 cache tests: whitespace-normalized keys, atomic tmp+rename writes, the
// 10,000-entry oldest-first cap, and the legacy flat-cache migration. All disk
// traffic goes through loadCache/saveCache's optional `file` test seam (temp
// dirs) — the real ~/.cache/jgrep is never touched, and jgrep()/scoreRows()
// run with an explicit apiKey + fake fetch so no key resolution happens.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, spyOn } from "bun:test";
import { jgrep, loadCache, saveCache, evict, normalizeForCache, CACHE_MAX_ENTRIES, type Cache, type Chunk } from "./jgrep";
import { scoreRows, type Questions, type Row } from "./rows";
import type { Fetch } from "./providers";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-cache-test-"));

const chunkOf = (text: string): Chunk => ({ file: "f.ts", start: 1, end: 6, text });

const BASE = "function one() {\n  return 1;\n}\nfunction two() {\n  return 2;\n}";
// Whitespace-only variant of BASE that must share its key: trailing spaces, blank-line
// churn and CRLF line endings — but the SAME leading indentation (B2: indent-aware).
const VARIANT = "function one() {  \r\n\r\n  return 1;  \n\n\n}\nfunction two() {\t\r\n  return 2;\n}\n";
// Semantically different from BASE: must NOT share a cache key with it.
const CHANGED = "function one() {\n  return 3;\n}\nfunction two() {\n  return 2;\n}";

const okFetch = (calls: unknown[]) =>
  (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    // Answers keyed off the REQUEST's question ids: votes>1 asks c0#v0..c0#vN,
    // so keying off chunk ids would answer nothing and every vote looks missing.
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: 0.9 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
  }) as unknown as typeof fetch;

// Rows requests carry state.rows (not state.chunks) and question ids "r0.match"…
const okRowsFetch = (calls: unknown[]) =>
  (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const answers: Record<string, unknown> = {};
    for (const r of body.state.rows) answers[`${r.id}.match`] = { type: "noul", noul: 0.9 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
  }) as unknown as typeof fetch;

const opts = (cache: Cache, fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) => ({
  threshold: 0.7, batch: 2, concurrency: 1, apiKey: "k", fetchImpl, cache, ...extra,
});

// ---- normalizeForCache --------------------------------------------------------

test("normalizeForCache: trailing-whitespace/blank-line/CRLF churn collapses to one identity; content and indentation changes do not", () => {
  expect(normalizeForCache(VARIANT)).toBe(normalizeForCache(BASE));
  expect(normalizeForCache(CHANGED)).not.toBe(normalizeForCache(BASE));
  expect(normalizeForCache("  a \n\tb\n\nc\n")).toBe("  a\n\tb\nc"); // leading indentation kept (B2)
  expect(normalizeForCache("")).toBe(""); // empty text stays empty, no crash
});

// ---- normalized persistent keys (jgrep) ---------------------------------------

test("cache keys are normalized: a trailing-space/blank-line/CRLF variant re-run is cache-served, 0 new requests", async () => {
  const file = path.join(tmpDir(), "cache.json");
  const calls: unknown[] = [];
  const fetchImpl = okFetch(calls);

  const cache1: Cache = {};
  const r1 = await jgrep("swallows errors", [chunkOf(BASE)], opts(cache1, fetchImpl));
  expect(calls).toHaveLength(1); // the first sighting is a real request
  expect(r1.cached).toBe(0);
  saveCache(cache1, file);

  const r2 = await jgrep("swallows errors", [chunkOf(VARIANT)], opts(loadCache(file), fetchImpl));
  expect(calls).toHaveLength(1); // the whitespace-churned twin is served from cache
  expect(r2.cached).toBe(1);
});

test("cache keys still distinguish content: a semantically different chunk re-bills", async () => {
  const file = path.join(tmpDir(), "cache.json");
  const calls: unknown[] = [];
  const fetchImpl = okFetch(calls);
  const cache1: Cache = {};
  await jgrep("swallows errors", [chunkOf(BASE)], opts(cache1, fetchImpl));
  saveCache(cache1, file);
  const r2 = await jgrep("swallows errors", [chunkOf(CHANGED)], opts(loadCache(file), fetchImpl));
  expect(calls).toHaveLength(2); // real content change -> a real request
  expect(r2.cached).toBe(0);
});

test("vote suffixes compose after the normalized base: whitespace-variant re-run replays both votes free", async () => {
  const file = path.join(tmpDir(), "cache.json");
  const calls: unknown[] = [];
  const fetchImpl = okFetch(calls);
  const cache1: Cache = {};
  const r1 = await jgrep("swallows errors", [chunkOf(BASE)], opts(cache1, fetchImpl, { votes: 2 }));
  expect(calls).toHaveLength(1); // one request carrying both vote questions
  expect(Object.keys(cache1).every((k) => k.endsWith("#v0") || k.endsWith("#v1"))).toBe(true);
  saveCache(cache1, file);
  const r2 = await jgrep("swallows errors", [chunkOf(VARIANT)], opts(loadCache(file), fetchImpl, { votes: 2 }));
  expect(calls).toHaveLength(1); // median replayed from the #v0/#v1 entries
  expect(r2.cached).toBe(1);
});

// ---- rows: normalized judged-field key ----------------------------------------

test("rows: a whitespace-variant row is cache-served through the normalized judged-field key", async () => {
  const file = path.join(tmpDir(), "cache.json");
  const calls: unknown[] = [];
  const fetchImpl = okRowsFetch(calls);
  const questions: Questions = { match: { type: "noul", instructions: "is this skincare?" } };
  const rows1: Row[] = [{ handle: "@a", bio: "morning routine\nserum first\nspf always" }];
  const rows2: Row[] = [{ handle: "@a", bio: "morning routine  \r\n\nserum first  \n\nspf always\n" }];

  const cache1: Cache = {};
  const r1 = await scoreRows(rows1, questions, { batch: 4, concurrency: 1, apiKey: "k", fetchImpl, cache: cache1 });
  expect(r1.requests).toBe(1);
  expect(r1.cached).toBe(0);
  saveCache(cache1, file);

  const r2 = await scoreRows(rows2, questions, { batch: 4, concurrency: 1, apiKey: "k", fetchImpl, cache: loadCache(file) });
  expect(r2.requests).toBe(0); // whitespace-only reformat of the row: no re-bill
  expect(r2.cached).toBe(1);
  expect(r2.answers[0]?.match?.noul).toBe(0.9);
});

// ---- atomic writes --------------------------------------------------------------

test("saveCache: writes .tmp-<pid> then renames into place — no tmp file left behind", () => {
  const dir = tmpDir();
  const file = path.join(dir, "cache.json");
  const spy = spyOn(fs, "renameSync");
  let renameArgs: unknown[] = [];
  try {
    saveCache({ a: 1 }, file);
    expect(spy).toHaveBeenCalledTimes(1);
    renameArgs = spy.mock.calls[0] as unknown[];
  } finally {
    spy.mockRestore();
  }
  expect(renameArgs[0]).toBe(`${file}.tmp-${process.pid}`); // same-dir tmp, pid-stamped
  expect(renameArgs[1]).toBe(file);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ v: 1, entries: { a: 1 }, order: ["a"] });
  expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]); // renamed away, not left behind
});

test("saveCache: a failure never corrupts an existing cache (best-effort, tmp cleaned up)", () => {
  const dir = tmpDir();
  const file = path.join(dir, "cache.json");
  saveCache({ keep: 1 }, file); // good state on disk
  const spy = spyOn(fs, "renameSync").mockImplementation(() => {
    throw new Error("EACCES: rename blocked");
  });
  try {
    expect(() => saveCache({ fresh: 2 }, file)).not.toThrow(); // best-effort: silent
  } finally {
    spy.mockRestore();
  }
  expect(JSON.parse(fs.readFileSync(file, "utf8")).entries).toEqual({ keep: 1 }); // old cache intact
  expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]); // tmp removed
});

// ---- size cap + oldest-first eviction -------------------------------------------

test("evict: at the cap the oldest-inserted keys drop first; under the cap it is a no-op", () => {
  const c: Cache = {};
  for (let i = 0; i < CACHE_MAX_ENTRIES + 5; i++) c[`k${String(i).padStart(5, "0")}`] = i;
  const out = evict(c);
  expect(Object.keys(out)).toHaveLength(CACHE_MAX_ENTRIES);
  expect(out["k00000"]).toBeUndefined(); // the 5 overflow entries are the OLDEST ones
  expect(out["k00004"]).toBeUndefined();
  expect(out["k00005"]).toBe(5); // first survivor is the front of the insertion order
  expect(out["k10004"]).toBe(CACHE_MAX_ENTRIES + 4); // newest judgments survive

  const small: Cache = { a: 1, b: 2, c: 3 };
  expect(evict(small, 5)).toBe(small); // no-op under the cap
  expect(Object.keys(evict({ x: 1, y: 2, z: 3 }, 2))).toEqual(["y", "z"]); // custom cap, front dropped
});

test("saveCache: the on-disk cache never exceeds the 10,000-entry cap, oldest entries evicted", () => {
  const file = path.join(tmpDir(), "cache.json");
  const c: Cache = {};
  for (let i = 0; i < CACHE_MAX_ENTRIES + 5; i++) c[`k${String(i).padStart(5, "0")}`] = i;
  saveCache(c, file);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(onDisk.v).toBe(1);
  expect(Object.keys(onDisk.entries)).toHaveLength(CACHE_MAX_ENTRIES);
  expect(onDisk.order).toHaveLength(CACHE_MAX_ENTRIES);
  expect(onDisk.entries["k00000"]).toBeUndefined(); // oldest gone
  expect(onDisk.order[0]).toBe("k00005"); // order front = oldest survivor
  expect(onDisk.entries["k10004"]).toBe(CACHE_MAX_ENTRIES + 4); // newest kept
  expect(loadCache(file)["k10004"]).toBe(CACHE_MAX_ENTRIES + 4); // loads back flat as before
});

// ---- legacy migration ------------------------------------------------------------

test("legacy flat cache: loads unchanged, re-saves in the v1 envelope without losing entries", () => {
  const file = path.join(tmpDir(), "cache.json");
  fs.writeFileSync(file, JSON.stringify({ legacykey1: 0.9, legacykey2: 0.1 }));
  const loaded = loadCache(file);
  expect(loaded).toEqual({ legacykey1: 0.9, legacykey2: 0.1 }); // entries kept as-is
  loaded.legacykey3 = 0.5; // a new judgment joins the same flat map
  saveCache(loaded, file);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(onDisk).toEqual({
    v: 1,
    entries: { legacykey1: 0.9, legacykey2: 0.1, legacykey3: 0.5 },
    order: ["legacykey1", "legacykey2", "legacykey3"], // Object.keys = insertion order
  });
  expect(loadCache(file)).toEqual(onDisk.entries); // the envelope loads back flat
});

test("loadCache: corrupt, empty, and missing files all degrade to an empty cache", () => {
  const dir = tmpDir();
  expect(loadCache(path.join(dir, "missing.json"))).toEqual({});
  const corrupt = path.join(dir, "corrupt.json");
  fs.writeFileSync(corrupt, "{not json");
  expect(loadCache(corrupt)).toEqual({});
  const scalar = path.join(dir, "scalar.json");
  fs.writeFileSync(scalar, "42");
  expect(loadCache(scalar)).toEqual({});
  const empty = path.join(dir, "empty.json");
  fs.writeFileSync(empty, "{}");
  expect(loadCache(empty)).toEqual({});
});

// ---- B2: indent-aware normalization ------------------------------------------
// USER decision 2026-10-02 (verbatim): "Indent-aware everywhere". Only trailing
// whitespace, blank lines and the line-ending style are normalized; leading indentation
// is meaning (Python blocks, YAML nesting, Makefile tabs, diff markers) and stays in
// both the persistent cache key and the in-run signature.
const PY_OUT = "if cond:\n    do_thing()\nreturn x";     // return runs always
const PY_IN = "if cond:\n    do_thing()\n    return x";  // return runs only when cond

/** Judge that tells the two Python snippets apart: p 0.9 only for the indented return. */
const pyJudge = (calls: unknown[]) =>
  (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const answers: Record<string, unknown> = {};
    for (const c of body.state.chunks) answers[c.id] = { type: "noul", noul: /\n {4}return x/.test(c.code) ? 0.9 : 0.1 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
  }) as unknown as typeof fetch;

test("B2 normalizeForCache / chunkSignature keep leading indentation; trailing space, blank lines and CRLF still collapse", async () => {
  const { chunkSignature } = await import("./jgrep");
  expect(normalizeForCache(PY_IN)).not.toBe(normalizeForCache(PY_OUT));
  expect(chunkSignature(PY_IN)).not.toBe(chunkSignature(PY_OUT));
  const churn = "if cond:   \r\n\r\n    do_thing()\t\r\n\n    return x\n\n";
  expect(normalizeForCache(churn)).toBe(normalizeForCache(PY_IN));
  expect(chunkSignature(churn)).toBe(chunkSignature(PY_IN));
});

test("B2 in-run: two Python snippets differing only in indentation are judged separately", async () => {
  const calls: unknown[] = [];
  const r = await jgrep("returns only when cond", [
    { file: "a.py", start: 1, end: 3, text: PY_OUT },
    { file: "b.py", start: 1, end: 3, text: PY_IN },
  ], opts({}, pyJudge(calls), { batch: 1 }));
  expect(calls).toHaveLength(2); // no signature clustering across the two
  expect(r.all.find((h) => h.file === "a.py")!.p).toBe(0.1);
  expect(r.all.find((h) => h.file === "b.py")!.p).toBe(0.9);
  expect(r.hits.map((h) => h.file)).toEqual(["b.py"]);
});

test("B2 persistent: a cached verdict for one indentation is never served for the other", async () => {
  const calls: unknown[] = [];
  const cache: Cache = {};
  await jgrep("returns only when cond", [{ file: "a.py", start: 1, end: 3, text: PY_OUT }], opts(cache, pyJudge(calls)));
  const r = await jgrep("returns only when cond", [{ file: "b.py", start: 1, end: 3, text: PY_IN }], opts(cache, pyJudge(calls)));
  expect(calls).toHaveLength(2); // b.py re-judged, not served from a.py's entry
  expect(r.cached).toBe(0);
  expect(r.hits.map((h) => h.p)).toEqual([0.9]);
});

test("B2 in-run: identical text under different markdown sections is judged per section (context in the signature)", async () => {
  const calls: unknown[] = [];
  const text = "Run the installer.\n\nThen restart.";
  await jgrep("explains uninstalling", [
    { file: "a.md", start: 1, end: 3, text, context: "Doc > Install" },
    { file: "a.md", start: 9, end: 11, text, context: "Doc > Uninstall" },
  ], opts({}, okFetch(calls), { batch: 1 }));
  expect(calls).toHaveLength(2);
});

test("votes=1: a corrupt cache value (null / string) is re-judged, never served as p", async () => {
  const chunks: Chunk[] = [{ file: "a.ts", start: 1, end: 2, text: "const a = 1;" }, { file: "b.ts", start: 1, end: 2, text: "const b = 2;" }];
  let calls = 0;
  const fetchImpl = (async (_u: unknown, init: { body: string }) => {
    calls++;
    const body = JSON.parse(init.body);
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: 0.9 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 1 } }), { status: 200 });
  }) as unknown as Fetch;
  const cache: Record<string, unknown> = {};
  await jgrep("q", chunks, { threshold: 0.7, batch: 2, concurrency: 1, apiKey: "k", fetchImpl, cache });
  const keys = Object.keys(cache);
  expect(keys).toHaveLength(2);
  cache[keys[0]] = null; cache[keys[1]] = "0.9"; // hand-edited / corrupt cache file
  const r = await jgrep("q", chunks, { threshold: 0.7, batch: 2, concurrency: 1, apiKey: "k", fetchImpl, cache });
  expect(calls).toBe(2); // before: both served from the corrupt entries, no request
  expect(r.cached).toBe(0);
  expect(r.all.every((h) => typeof h.p === "number" && Number.isFinite(h.p))).toBe(true);
});

test("saveCache: a failed save warns once on stderr instead of failing silently", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-cache-ro-"));
  try {
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "x"); // the cache's parent "directory" is a file: mkdir/write fail
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      saveCache({ k: 0.5 }, path.join(blocker, "cache.json"));
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toContain("could not save the jgrep cache");
    } finally { err.mockRestore(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cacheFilePath: honours an absolute XDG_CACHE_HOME, ignores a relative one", async () => {
  const { cacheFilePath } = await import("./jgrep");
  expect(cacheFilePath({ XDG_CACHE_HOME: "/var/xdg" }, "/home/u")).toBe(path.join("/var/xdg", "jgrep", "cache.json"));
  expect(cacheFilePath({ XDG_CACHE_HOME: "rel/dir" }, "/home/u")).toBe(path.join("/home/u", ".cache", "jgrep", "cache.json"));
  expect(cacheFilePath({}, "/home/u")).toBe(path.join("/home/u", ".cache", "jgrep", "cache.json"));
});
