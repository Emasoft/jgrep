// Markdown-aware chunking: heading-boundary sections with a context trail,
// frontmatter as its own chunk, blank-line force-splits that never break a fence.
import { test, expect } from "bun:test";
import { chunk, chunkMarkdown, isMarkdownPath, buildRequest, jgrep } from "./jgrep";

const fs = await import("node:fs");
const path = await import("node:path");

test("isMarkdownPath: the md family in, everything else out", () => {
  for (const f of ["a.md", "b.MD", "c.markdown", "d.mdx", "e.mkd", "f.mdown", "dir/g.Md"]) expect(isMarkdownPath(f)).toBe(true);
  for (const f of ["a.ts", "b.csv", "c", "d.mdx.txt", "e.md~"]) expect(isMarkdownPath(f)).toBe(false);
});

test("chunkMarkdown: frontmatter becomes its own first chunk without context", () => {
  const cs = chunkMarkdown("a.md", "---\nname: jgrep\nlicense: MIT\n---\n\n# Title\nbody\n");
  expect(cs[0]).toEqual({ file: "a.md", start: 1, end: 4, text: "---\nname: jgrep\nlicense: MIT\n---" });
  expect(cs[0].context).toBeUndefined();
  const body = cs.find((c) => c.context === "Title");
  // the trailing "" from the final newline is a line like in chunk(): it stays in the last section
  expect(body).toEqual({ file: "a.md", start: 6, end: 8, text: "# Title\nbody\n", context: "Title" });
});

test("chunkMarkdown: headings bound sections; absolute 1-based inclusive ranges and trails", () => {
  const cs = chunkMarkdown("a.md", "# A\nbody a1\nbody a2\n## B\nbody b1\n# C\nbody c1\n");
  expect(cs.map((c) => [c.start, c.end, c.context])).toEqual([[1, 3, "A"], [4, 5, "A > B"], [6, 8, "C"]]);
  expect(cs.map((c) => c.text)).toEqual(["# A\nbody a1\nbody a2", "## B\nbody b1", "# C\nbody c1\n"]);
});

test("chunkMarkdown: heading-only sections are kept (semantic units, no minLines merging)", () => {
  const cs = chunkMarkdown("a.md", "# A\n## B\nbody\n");
  expect(cs.map((c) => [c.start, c.end, c.context])).toEqual([[1, 1, "A"], [2, 4, "A > B"]]);
});

test("chunkMarkdown: oversized sections split at blank lines, same context, contiguous absolute ranges", () => {
  const lines = ["## Big"];
  for (let j = 0; j < 89; j++) lines.push(j % 10 === 9 ? "" : `body ${j}`); // 90 lines, blanks every 10th
  const cs = chunkMarkdown("a.md", lines.join("\n"), { minLines: 5, maxLines: 60 });
  expect(cs.map((c) => `${c.start}-${c.end}`)).toEqual(["1-51", "52-90"]);
  expect(cs.map((c) => c.context)).toEqual(["Big", "Big"]);
  for (const c of cs) {
    expect(c.end - c.start + 1).toBeLessThanOrEqual(60);
    expect(c.text.split("\n")).toHaveLength(c.end - c.start + 1); // range matches the text
  }
  expect(cs[1].start).toBe(cs[0].end + 1); // pieces tile the section
  expect(cs[0].text.startsWith("## Big")).toBe(true); // the heading leads the first piece
  expect(cs[0].text.endsWith("\n")).toBe(true); // the cut landed on a blank line, outside any fence
});

test("chunkMarkdown: a fence that outgrows maxLines is exceeded, never broken mid-block", () => {
  const lines = ["## Fenced", "intro", "```ts"];
  for (let j = 0; j < 70; j++) lines.push(`code ${j}`);
  lines.push("```", "outro");
  const cs = chunkMarkdown("a.md", lines.join("\n"), { minLines: 5, maxLines: 60 });
  expect(cs.map((c) => `${c.start}-${c.end}`)).toEqual(["1-74", "75-75"]);
  expect(cs[0].end - cs[0].start + 1).toBeGreaterThan(60); // by design: fence integrity wins over maxLines
  expect(cs[0].context).toBe("Fenced");
  expect(cs[0].text.split("\n").filter((l) => /^\s*```/.test(l))).toEqual(["```ts", "```"]); // open + close together
  expect(cs[0].text).toContain("code 0");
  expect(cs[0].text).toContain("code 69");
  expect(cs[1]).toEqual({ file: "a.md", start: 75, end: 75, text: "outro", context: "Fenced" });
});

test("chunkMarkdown: fenced blocks never leak headings — # lines inside a fence are body text", () => {
  const cs = chunkMarkdown("a.md", "## Code\n```bash\n# not a heading\nnpm i -g jevgrep\n```\nstill body\n");
  expect(cs).toHaveLength(1);
  expect(cs[0]).toMatchObject({ start: 1, end: 7, context: "Code" });
});

test("chunkMarkdown on the repo SKILL.md: the ## Help section is one chunk covering the fenced help block", () => {
  const HERE: string = (import.meta as { dir?: string }).dir ?? process.cwd();
  const text = fs.readFileSync(path.join(HERE, "..", "skills", "jgrep", "SKILL.md"), "utf8");
  const cs = chunkMarkdown("skills/jgrep/SKILL.md", text);
  const lines = text.split("\n");
  // chunks are start-ordered and the frontmatter leads without a trail
  expect(cs.every((c, i) => i === 0 || cs[i - 1].start < c.start)).toBe(true);
  expect(cs[0].start).toBe(1);
  expect(cs[0].context).toBeUndefined();
  expect(cs[0].text).toBe(lines.slice(0, lines.indexOf("---", 1) + 1).join("\n"));
  // the Help section: heading through the line before the next heading, ONE chunk, no force-split
  const help = cs.filter((c) => c.context === "jgrep > Help");
  expect(help).toHaveLength(1);
  expect(help[0].start).toBe(lines.indexOf("## Help") + 1);
  expect(help[0].end).toBe(lines.indexOf("## Reading results")); // through the line before the next heading
  expect(help[0].end - help[0].start + 1).toBeLessThanOrEqual(60);
  expect(help[0].text).toBe(lines.slice(help[0].start - 1, help[0].end).join("\n"));
  // the full fenced help block rides inside this one chunk, fence open + close intact
  expect(help[0].text).toContain("jgrep --help` prints the full reference");
  expect(help[0].text).toContain("exit status: 0 when something matched, 1 when nothing did");
  expect(help[0].text).toContain('OPENROUTER_API_KEY=sk-or-... jgrep --api openrouter "swallows errors" src/');
  expect(help[0].text.split("\n").filter((l) => /^\s*```/.test(l))).toEqual(["```", "```"]);
});

test("buildRequest: markdown chunks prepend the section trail; code chunks stay byte-identical", () => {
  const md = chunkMarkdown("a.md", "# Guide\nbody\n");
  expect((buildRequest("q", md, "code").questions.c0 as any).instructions)
    .toBe('Look only at the chunk with id "c0". [Section context: Guide] Does that code match this description: q');
  const code = chunk("f.ts", "const x = 1;\n");
  expect((buildRequest("q", code, "code").questions.c0 as any).instructions)
    .toBe('Look only at the chunk with id "c0". Does that code match this description: q');
});

test("jgrep: markdown chunks batch, route and cache like code chunks (context rides in the key)", async () => {
  const cs = chunkMarkdown("a.md", "# Guide\ncatch (e) {}\n## Else\nother\n");
  expect(cs.map((c) => c.context)).toEqual(["Guide", "Guide > Else"]);
  const calls: any[] = [];
  const fetchImpl = (async (_url: string, init: any) => {
    const req = JSON.parse(init.body);
    calls.push(req);
    const answers: any = {};
    for (const c of req.state.chunks) answers[c.id] = { type: "noul", noul: c.code.includes("catch (e) {}") ? 0.95 : 0.05 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
  }) as any;
  const cache: Record<string, number> = {};
  const q = "swallows errors";
  const r = await jgrep(q, cs, { threshold: 0.7, batch: 2, concurrency: 4, apiKey: "k", fetchImpl, cache });
  expect(r.hits.map((h) => h.start)).toEqual([1]);
  expect(calls[0].questions.c0.instructions).toContain("[Section context: Guide]");
  const r2 = await jgrep(q, cs, { threshold: 0.7, batch: 2, concurrency: 4, apiKey: "k", fetchImpl, cache });
  expect(r2.cached).toBe(cs.length); // all cached: the context-carrying keys round-trip
});
