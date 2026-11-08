// Diagnostics: open /api/health in a browser to check the Gemini setup.
// Runs a few tiny Gemini requests and reports what happened and how long each took.
import { GoogleGenAI } from '@google/genai';
import { pickDefaultModel, generateStory, listGenerateModels, chooseModel } from '../lib/story.js';

const STEP_TIMEOUT_MS = 30_000;

// Gemini errors arrive as (sometimes double-encoded) JSON; pull out the readable message.
function readable(err) {
  const raw = String(err?.message || err);
  const messages = [...raw.matchAll(/message\\*":\s*\\*"([^"\\]+)/g)].map((m) => m[1]).filter((m) => m.trim() !== '{');
  return (messages.at(-1) || raw).slice(0, 300);
}

async function step(name, fn) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
  try {
    const result = await fn(controller.signal);
    return { step: name, ok: true, ms: Date.now() - started, result };
  } catch (err) {
    return {
      step: name,
      ok: false,
      ms: Date.now() - started,
      error: controller.signal.aborted ? `no response within ${STEP_TIMEOUT_MS / 1000}s` : readable(err),
      status: err?.status,
    };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  const info = {
    modelFromEnv: Boolean(process.env.GEMINI_MODEL),
    apiKeySet: Boolean(process.env.GEMINI_API_KEY),
    node: process.version,
    region: process.env.VERCEL_REGION || null,
  };
  if (!info.apiKeySet) return res.status(200).json({ ...info, steps: [] });

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = await pickDefaultModel(ai);
  info.model = model;
  const tiny = 'Reply with the single word: hello';
  const steps = [];

  steps.push(await step('models this key can use', async (abortSignal) =>
    (await listGenerateModels(ai, abortSignal)).filter((n) => /flash/.test(n))));

  steps.push(await step(`generate (${model})`, async (abortSignal) =>
    (await ai.models.generateContent({ model, contents: tiny, config: { abortSignal } })).text));

  steps.push(await step(`stream (${model})`, async (abortSignal) => {
    let text = '';
    for await (const c of await ai.models.generateContentStream({ model, contents: tiny, config: { abortSignal } })) text += c.text || '';
    return text;
  }));

  // Speed test: the same 1-minute story with the chosen model and the newest
  // non-Lite Flash model, for comparison.
  const names = steps[0].ok ? steps[0].result : [];
  const flash = chooseModel(names.filter((n) => !/lite/.test(n)));
  const setups = [{ model }, ...(flash && flash !== model ? [{ model: flash, thinkingLevel: 'LOW' }] : [])];
  const speed = [];
  for (const setup of setups) {
    speed.push(await step(`story: ${setup.model}, thinking ${setup.thinkingLevel || 'default'}`, async () => {
      const s = await generateStory(
        { name: 'Maya', age: 5, topic: 'a sleepy dragon', minutes: 1 },
        { ...setup, firstChunkTimeoutMs: STEP_TIMEOUT_MS },
      );
      return { geminiReplyMs: s.trace.geminiResponseMs, firstTextMs: s.trace.firstTextMs, totalMs: s.latencyMs, words: s.wordCount };
    }));
  }

  console.log('health:', JSON.stringify({ steps, speed }));
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(JSON.stringify({ ...info, steps, speed }, null, 2));
}
