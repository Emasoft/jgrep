// jgrep --rows: every row of a CSV / JSONL file is one state; a question file
// (Jev question objects, passed through verbatim) is asked of every row, many
// rows per request. Output is the table with one answer column per question.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { MODEL, postSystemOne, type Cache, type Fetch } from "./jgrep";

export type Row = Record<string, string>;
export type Questions = Record<string, { type: "noul" | "choice" | "score"; instructions: string; [k: string]: unknown }>;
export type Answer = { type: string; noul?: number; choice?: string; score?: number; confidence?: number; probabilities?: Record<string, number> };

// ---- input ------------------------------------------------------------------
export function parseCsv(text: string): { columns: string[]; rows: Row[] } {
  const recs: string[][] = [];
  let rec: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { rec.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      rec.push(field); field = ""; recs.push(rec); rec = [];
    } else field += c;
  }
  if (field !== "" || rec.length) { rec.push(field); recs.push(rec); }
  const [columns = [], ...body] = recs.filter((r) => r.some((f) => f !== ""));
  const rows = body.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ""])));
  return { columns, rows };
}

export function readRows(file: string): { columns: string[]; rows: Row[] } {
  const text = fs.readFileSync(file, "utf8");
  if (/\.jsonl?$/i.test(file)) {
    const rows: Row[] = file.toLowerCase().endsWith(".json")
      ? JSON.parse(text)
      : text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    return { columns, rows };
  }
  return parseCsv(text);
}

/** A questions file is a JSON object of Jev questions. A bare string becomes one Noul named `match`. */
export function loadQuestions(fileOrText: string): Questions {
  if (fs.existsSync(fileOrText)) {
    const q = JSON.parse(fs.readFileSync(fileOrText, "utf8")) as Questions;
    for (const [name, spec] of Object.entries(q)) {
      if (!spec || !["noul", "choice", "score"].includes(spec.type) || typeof spec.instructions !== "string")
        throw new Error(`question "${name}" needs {type: noul|choice|score, instructions: "..."}`);
      if (name.includes(".")) throw new Error(`question name "${name}" must not contain "."`);
    }
    return q;
  }
  return { match: { type: "noul", instructions: fileOrText } };
}

// ---- request ----------------------------------------------------------------
export const MAX_QUESTIONS_PER_REQUEST = 64;

export function buildRowsRequest(rows: Row[], questions: Questions) {
  const state = { rows: rows.map((r, i) => ({ id: `r${i}`, ...r })) };
  const qs: Record<string, unknown> = {};
  rows.forEach((_, i) => {
    for (const [name, spec] of Object.entries(questions)) {
      qs[`r${i}.${name}`] = { ...spec, instructions: `Look only at the row with id "r${i}". ${spec.instructions}` };
    }
  });
  return { model: MODEL, state, questions: qs };
}

const key = (qJson: string, r: Row) => createHash("sha1").update(`${MODEL}\0rows\0${qJson}\0${JSON.stringify(r)}`).digest("hex");

export interface RowsOptions {
  batch: number; concurrency: number; apiKey: string;
  fetchImpl?: Fetch; cache?: Cache; onProgress?: (done: number, total: number) => void;
}

export async function scoreRows(rows: Row[], questions: Questions, o: RowsOptions): Promise<{ answers: Record<string, Answer>[]; tokens: number; cached: number; requests: number }> {
  const qJson = JSON.stringify(questions);
  const cache = o.cache ?? {};
  const f = o.fetchImpl ?? fetch;
  const answers: Record<string, Answer>[] = new Array(rows.length);
  const todo: number[] = [];
  rows.forEach((r, i) => { const hit = cache[key(qJson, r)]; if (hit) answers[i] = hit; else todo.push(i); });
  const per = Math.max(1, Math.min(o.batch, Math.floor(MAX_QUESTIONS_PER_REQUEST / Object.keys(questions).length)));
  const batches: number[][] = [];
  for (let i = 0; i < todo.length; i += per) batches.push(todo.slice(i, i + per));
  let tokens = 0, done = 0, next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const b = batches[next++];
      const res = await postSystemOne(buildRowsRequest(b.map((i) => rows[i]), questions), o.apiKey, { fetchImpl: f });
      tokens += res.usage?.input_tokens ?? 0;
      b.forEach((ri, j) => {
        const a: Record<string, Answer> = {};
        for (const name of Object.keys(questions)) a[name] = res.answers[`r${j}.${name}`] ?? { type: "missing" };
        answers[ri] = a;
        if (Object.values(a).every((x) => x.type !== "missing")) cache[key(qJson, rows[ri])] = a;
      });
      o.onProgress?.(++done, batches.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency, batches.length) }, worker));
  return { answers, tokens, cached: rows.length - todo.length, requests: batches.length };
}

// ---- output -----------------------------------------------------------------
/** noul -> `q` (probability); choice -> `q` + `q_p`; score -> `q` + `q_conf`. */
export function flatten(a: Record<string, Answer>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, ans] of Object.entries(a)) {
    if (ans.type === "noul") out[name] = round(ans.noul);
    else if (ans.type === "choice") { out[name] = ans.choice ?? ""; out[`${name}_p`] = round(ans.probabilities?.[ans.choice ?? ""]); }
    else if (ans.type === "score") { out[name] = round(ans.score); out[`${name}_conf`] = round(ans.confidence); }
    else out[name] = "";
  }
  return out;
}
const round = (n: unknown) => (typeof n === "number" ? Math.round(n * 100) / 100 : "");

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.map(esc).join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}
