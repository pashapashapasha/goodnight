// Run every case in evals/cases.json through the generator and save results.
// Usage: GEMINI_API_KEY=... node scripts/eval.js [--model gemini-x] [--only id1,id2]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { generateStory, DEFAULT_MODEL } from '../lib/story.js';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const model = flag('--model') || DEFAULT_MODEL;
const only = flag('--only')?.split(',');
const delayMs = Number(flag('--delay') ?? 5000); // stay under free-tier per-minute limits

if (!process.env.GEMINI_API_KEY) { console.error('Set GEMINI_API_KEY'); process.exit(1); }

const cases = JSON.parse(await readFile(new URL('../evals/cases.json', import.meta.url)))
  .filter((c) => !only || only.includes(c.id));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = new URL(`../evals/runs/${stamp}/`, import.meta.url);
await mkdir(outDir, { recursive: true });

const results = [];
for (const [i, c] of cases.entries()) {
  if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
  process.stdout.write(`${c.id} ... `);
  try {
    const s = await generateStory(c, { model });
    const lengthRatio = +(s.wordCount / s.targetWords).toFixed(2);
    const mentionsName = s.body.includes(c.name);
    results.push({ ...c, ok: true, title: s.title, wordCount: s.wordCount, targetWords: s.targetWords, lengthRatio, mentionsName, geminiResponseMs: s.trace.geminiResponseMs, thoughtsTokens: s.trace.thoughtsTokens, firstChunkMs: s.firstChunkMs, latencyMs: s.latencyMs, trace: s.trace });
    await writeFile(new URL(`${c.id}.md`, outDir), `# ${s.title}\n\n${s.body}\n\n---\nprompt:\n${s.prompt}\n`);
    console.log(`${s.wordCount}/${s.targetWords} words (x${lengthRatio}), ${s.latencyMs}ms`);
  } catch (err) {
    results.push({ ...c, ok: false, error: err.message });
    console.log(`FAILED: ${err.message}`);
  }
}

await writeFile(new URL('results.json', outDir), JSON.stringify({ model, results }, null, 2));
console.table(results.map(({ id, ok, wordCount, targetWords, lengthRatio, mentionsName, geminiResponseMs, thoughtsTokens, firstChunkMs, latencyMs }) =>
  ({ id, ok, wordCount, targetWords, lengthRatio, mentionsName, geminiResponseMs, thoughtsTokens, firstChunkMs, latencyMs })));
console.log(`Saved to ${outDir.pathname}`);
