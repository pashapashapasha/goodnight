// Diagnostics: open /api/health in a browser to check the Gemini setup.
// Runs a few tiny Gemini requests and reports what happened and how long each took.
import { GoogleGenAI } from '@google/genai';
import { DEFAULT_MODEL, generateStory } from '../lib/story.js';

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
  const model = DEFAULT_MODEL;
  const info = {
    model,
    modelFromEnv: Boolean(process.env.GEMINI_MODEL),
    apiKeySet: Boolean(process.env.GEMINI_API_KEY),
    node: process.version,
    region: process.env.VERCEL_REGION || null,
  };
  if (!info.apiKeySet) return res.status(200).json({ ...info, steps: [] });

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const tiny = 'Reply with the single word: hello';
  const steps = [];

  steps.push(await step('list flash models', async (abortSignal) => {
    const names = [];
    const pager = await ai.models.list({ config: { pageSize: 100, abortSignal } });
    for await (const m of pager) {
      if (/flash/.test(m.name) && (m.supportedActions || []).includes('generateContent')) names.push(m.name.replace(/^models\//, ''));
    }
    return names;
  }));

  steps.push(await step(`generate (${model}, default thinking)`, async (abortSignal) =>
    (await ai.models.generateContent({ model, contents: tiny, config: { abortSignal } })).text));

  steps.push(await step(`generate (${model}, thinking LOW)`, async (abortSignal) =>
    (await ai.models.generateContent({ model, contents: tiny, config: { abortSignal, thinkingConfig: { thinkingLevel: 'LOW' } } })).text));

  steps.push(await step(`stream (${model}, thinking LOW)`, async (abortSignal) => {
    let text = '';
    const stream = await ai.models.generateContentStream({ model, contents: tiny, config: { abortSignal, thinkingConfig: { thinkingLevel: 'LOW' } } });
    for await (const c of stream) text += c.text || '';
    return text;
  }));

  // Speed test: the same 1-minute story with a few model/thinking setups.
  const flashModels = steps[0].ok ? steps[0].result : [];
  const version = (name) => parseFloat((name.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const lite = flashModels
    .filter((n) => /flash-lite/.test(n) && !/tts|image|live|audio/.test(n))
    .sort((a, b) => version(b) - version(a) || /preview/.test(a) - /preview/.test(b))[0];
  const setups = [
    { model, thinkingLevel: 'LOW' },
    { model, thinkingLevel: 'MINIMAL' },
    ...(lite ? [{ model: lite, thinkingLevel: 'MINIMAL' }] : []),
  ];
  const speed = [];
  for (const setup of setups) {
    const r = await step(`story: ${setup.model}, thinking ${setup.thinkingLevel}`, async () => {
      const s = await generateStory(
        { name: 'Maya', age: 5, topic: 'a sleepy dragon', minutes: 1 },
        { ...setup, firstChunkTimeoutMs: STEP_TIMEOUT_MS },
      );
      return { firstTextMs: s.firstChunkMs, totalMs: s.latencyMs, words: s.wordCount };
    });
    speed.push(r);
  }

  console.log('health:', JSON.stringify({ steps, speed }));
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(JSON.stringify({ ...info, steps, speed }, null, 2));
}
