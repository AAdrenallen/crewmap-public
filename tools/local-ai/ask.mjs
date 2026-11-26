#!/usr/bin/env node
/**
 * Ask the local LLM (start it first with tools/local-ai/start.sh). Prints only the answer, to save Claude tokens.
 *   node tools/local-ai/ask.mjs "Summarise the failures" < build.log
 *   node tools/local-ai/ask.mjs --files a.ts b.ts -- "Review this for bugs; list file:line + issue, max 10 lines"
 *   node tools/local-ai/ask.mjs --json "Translate these i18n values to French (Québec) and Russian; keep keys" < en.json
 * Good for mechanical work: log triage, translations, first-pass diff review, boilerplate. Not for design decisions.
 */
import fs from 'node:fs';

const PORT = process.env.LOCAL_AI_PORT ?? '8089';
const args = process.argv.slice(2);
let files = [];
let json = false;
const prompt = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--files') {
    while (args[i + 1] && args[i + 1] !== '--') files.push(args[++i]);
    if (args[i + 1] === '--') i++;
  } else if (args[i] === '--json') json = true;
  else prompt.push(args[i]);
}
let input = '';
if (!process.stdin.isTTY) input = fs.readFileSync(0, 'utf8');
const ctx = files.map((f) => `--- ${f}\n${fs.readFileSync(f, 'utf8')}`).join('\n\n');
const user = [prompt.join(' '), ctx, input].filter(Boolean).join('\n\n').slice(0, 48_000);

const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    messages: [
      { role: 'system', content: `Be concise and exact. ${json ? 'Answer with valid JSON only.' : 'No preamble.'}` },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    max_tokens: 2048,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  }),
}).catch(() => null);
if (!res || !res.ok) {
  console.error('local AI not reachable — run: bash tools/local-ai/start.sh');
  process.exit(1);
}
const out = await res.json();
process.stdout.write((out.choices?.[0]?.message?.content ?? '').trim() + '\n');
