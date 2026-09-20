// Step 4 rewire tests: the core consumes the provider layer (BACKENDS, postSystemOne)
// instead of hardcoded ENDPOINT/MODEL consts. Every run below passes an explicit
// apiKey so the lazy key resolver never touches the filesystem or env.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
import { BACKENDS, type Fetch } from "./providers";
import { buildRequest, chunk, jgrep, type Chunk } from "./jgrep";
import { buildRowsRequest, scoreRows } from "./rows";

// ---- fakes: repo fake-fetch DI pattern, extended to capture the request URL ----

const captureFetch = (p = 0.9) => {
  const calls: { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
  const fetchImpl = (async (url: unknown, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url: String(url), init });
    const req = JSON.parse(init.body!);
    const answers: Record<string, unknown> = {};
    for (const c of req.state.chunks) answers[c.id] = { type: "noul", noul: p };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
  }) as unknown as Fetch;
  return { calls, fetchImpl };
};

const src = `import a from "a";\n\nexport function one() {\n  try { save() } catch (e) { log(e); throw e }\n}\n`;
const chunks = (): Chunk[] => chunk("f.ts", src, { minLines: 3, maxLines: 60 });

// ---- (a) buildRequest model param --------------------------------------------

test("buildRequest: 4th model param lands in the payload; default stays jev-latest", () => {
  expect(buildRequest("q", chunks(), "code", "custom-model").model).toBe("custom-model");
  expect(buildRequest("q", chunks(), "diff", "typesafe/jev-1.13").model).toBe("typesafe/jev-1.13");
  expect(buildRequest("q", chunks()).model).toBe("jev-latest"); // pre-0.4 payload, byte-identical
});

// ---- (b) jgrep cache keys are model-scoped ------------------------------------

test("jgrep cache keys include the model: different model re-requests, same model stays cached", async () => {
  const { calls, fetchImpl } = captureFetch();
  const cache: Record<string, number> = {};
  const base = { threshold: 0.7, batch: 2, concurrency: 4, apiKey: "k", fetchImpl, cache };
  await jgrep("swallows errors", chunks(), { ...base, model: "m-a" });
  expect(calls).toHaveLength(1);
  await jgrep("swallows errors", chunks(), { ...base, model: "m-b" });
  expect(calls).toHaveLength(2); // model changed -> cache key differs -> fresh request
  const r3 = await jgrep("swallows errors", chunks(), { ...base, model: "m-a" });
  expect(calls).toHaveLength(2); // same model as run 1 -> fully cached, no new calls
  expect(r3.cached).toBe(1);
});

// ---- (c) backend routing -------------------------------------------------------

test("jgrep with backend: openrouter + apiKey hits the openrouter URL with its model", async () => {
  const { calls, fetchImpl } = captureFetch();
  const r = await jgrep("q", chunks(), {
    threshold: 0.7, batch: 2, concurrency: 4, apiKey: "k",
    backend: BACKENDS.openrouter, fetchImpl, cache: {},
  });
  expect(r.hits).toHaveLength(1);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://openrouter.ai/api/alpha/decisions");
  expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer k", "X-Title": "jevgrep" });
  expect(JSON.parse(calls[0].init.body!).model).toBe("~typesafe/jev-latest"); // backend.model, not the typesafe default
});

// ---- (d) the byte-identical default --------------------------------------------

test("jgrep defaults stay byte-identical: typesafe URL, jev-latest model, unchanged payload shape", async () => {
  const { calls, fetchImpl } = captureFetch();
  const cs = chunks();
  await jgrep("q", cs, { threshold: 0.7, batch: 2, concurrency: 4, apiKey: "k", fetchImpl, cache: {} });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
  const body = JSON.parse(calls[0].init.body!);
  expect(body.model).toBe("jev-latest");
  expect(body.state.chunks[0]).toEqual({ id: "c0", file: "f.ts", lines: "1-6", code: cs[0].text });
  expect(Object.keys(body.questions)).toEqual(["c0"]);
});

// ---- (e) scoreRows model param: payload + cache key -----------------------------

test("scoreRows: explicit model lands in the payload and scopes the cache key", async () => {
  const rows = [{ handle: "@a", bio: "skincare" }, { handle: "@b", bio: "cars" }];
  const questions = { match: { type: "noul" as const, instructions: "beauty content?" } };
  expect(buildRowsRequest(rows, questions, "custom-rows-model").model).toBe("custom-rows-model");
  expect(buildRowsRequest(rows, questions).model).toBe("jev-latest"); // pre-0.4 default

  const calls: { url: string; body: Record<string, any> }[] = [];
  const fetchImpl = (async (url: unknown, init: { body?: string }) => {
    const body = JSON.parse(init.body!);
    calls.push({ url: String(url), body });
    const answers: Record<string, unknown> = {};
    for (const r of body.state.rows) answers[`${r.id}.match`] = { type: "noul", noul: 0.9 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 5 } }), { status: 200 });
  }) as unknown as Fetch;

  const cache: Record<string, unknown> = {};
  const base = { batch: 16, concurrency: 4, apiKey: "k", fetchImpl, cache };
  const r1 = await scoreRows(rows, questions, { ...base, model: "m-1" });
  expect(r1.requests).toBe(1);
  expect(calls).toHaveLength(1);
  expect(calls[0].body.model).toBe("m-1");
  expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone"); // default backend is typesafe
  await scoreRows(rows, questions, { ...base, model: "m-2" });
  expect(calls).toHaveLength(2); // model differs -> cache key differs -> requested again
  expect(calls[1].body.model).toBe("m-2");
  const r3 = await scoreRows(rows, questions, { ...base, model: "m-1" });
  expect(calls).toHaveLength(2); // same model as run 1 -> fully cached
  expect(r3.cached).toBe(2);
});
