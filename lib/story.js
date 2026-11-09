// Story generation, kept separate from the UI so it can be called from the
// web API, the eval script, or a REPL.
import { GoogleGenAI } from '@google/genai';

// The model to use when GEMINI_MODEL isn't set: the newest Flash-Lite model the
// API key can use, found by asking Google (see pickDefaultModel). Flash-Lite
// answers quickly on the free tier; gemini-3.8-flash was observed holding
// requests for 60s+ without responding, and the gemini-flash-lite-latest alias
// was not found.
export const DEFAULT_MODEL = process.env.GEMINI_MODEL || null;
// Used only if listing models fails.
export const FALLBACK_MODEL = 'gemini-3.5-flash-lite';

// Reading aloud to a child is slower than silent reading.
export const WORDS_PER_MINUTE = 130;

export const LIMITS = {
  nameMaxLength: 40,
  topicMaxLength: 200,
  minAge: 1,
  maxAge: 12,
  minMinutes: 1,
  maxMinutes: 20,
};

export const DEFAULT_MINUTES = 5;

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

/**
 * Validate and normalise raw input. Every field is optional: a missing name,
 * age or topic is left for the model to fill in (name/topic become '' and age
 * becomes null), and a missing length defaults to DEFAULT_MINUTES.
 * Throws an Error with a user-facing message for values that are given but invalid.
 */
export function normalizeInput(raw = {}) {
  const name = String(raw.name ?? '').trim();
  const topic = String(raw.topic ?? '').trim();
  const age = blank(raw.age) ? null : Number(raw.age);
  const minutes = blank(raw.minutes) ? DEFAULT_MINUTES : Number(raw.minutes);

  if (name.length > LIMITS.nameMaxLength) throw new Error(`Name must be at most ${LIMITS.nameMaxLength} characters.`);
  if (topic.length > LIMITS.topicMaxLength) throw new Error(`Topic must be at most ${LIMITS.topicMaxLength} characters.`);
  if (age !== null && (!Number.isInteger(age) || age < LIMITS.minAge || age > LIMITS.maxAge)) {
    throw new Error(`Age must be a whole number from ${LIMITS.minAge} to ${LIMITS.maxAge}.`);
  }
  if (!Number.isFinite(minutes) || minutes < LIMITS.minMinutes || minutes > LIMITS.maxMinutes) {
    throw new Error(`Length must be ${LIMITS.minMinutes} to ${LIMITS.maxMinutes} minutes.`);
  }
  return { name, age, topic, minutes };
}

export function targetWordCount(minutes) {
  return Math.round(minutes * WORDS_PER_MINUTE);
}

export const SYSTEM_INSTRUCTION = `You write original bedtime stories for young children, to be read aloud by a parent.
- Calm, warm and gently paced; the story winds down toward sleep at the end.
- Nothing scary, violent or upsetting. Any conflict is small and resolves kindly.
- Vocabulary and sentence length suited to the child's age.
- If a child's name is given, that child is the main character, referred to by their name.
- Hit the requested word count closely; it determines how long the story takes to read.
- Output format: a title on the first line prefixed with "# ", a blank line, then the story in plain paragraphs. No other markdown, no notes, no preamble.`;

// Prompt versions, for comparing changes in evals. The app always uses v1;
// evals pick one with EVAL_PROMPT (see evals/story.eval.js).
export const PROMPT_ADDITIONS = {
  v1: '',
  v2: '\nUse sensory details: sounds, textures, warmth. Make the last paragraph slower and quieter, ending with the main character falling asleep.',
};

export function buildPrompt({ name, age, topic, minutes }, promptVersion = 'v1') {
  if (!(promptVersion in PROMPT_ADDITIONS)) throw new Error(`Unknown prompt version "${promptVersion}".`);
  const words = targetWordCount(minutes);
  return `Write a bedtime story.
Child's name: ${name || 'not given (invent a gentle main character)'}
Child's age: ${age ?? 'not given (write for a child of about 3 to 7)'}
Topic: ${topic || 'your choice (something cozy and a little magical)'}
Target length: about ${words} words (roughly ${minutes} minute${minutes === 1 ? '' : 's'} read aloud). Stay within 10% of this.${PROMPT_ADDITIONS[promptVersion]}`;
}

/** Split model output into { title, body }. */
export function parseStory(text) {
  const trimmed = (text || '').trim();
  const match = trimmed.match(/^#\s*(.+)\n+([\s\S]*)$/);
  if (match) return { title: match[1].trim(), body: match[2].trim() };
  return { title: 'A Bedtime Story', body: trimmed };
}

export function countWords(text) {
  return (text.match(/\S+/g) || []).length;
}

// Thinking adds latency and doesn't help a bedtime story. Gemini 3 models take a
// thinking level; older (2.5) models take a token budget.
function thinkingConfig(model, level) {
  if (/gemini-2\./.test(model)) return { thinkingBudget: level === 'MINIMAL' ? 0 : 1024 };
  return { thinkingLevel: level };
}

export const DEFAULT_TIMEOUT_MS = 240_000;
// Give up if Gemini sends no text at all for this long.
export const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 60_000;

const version = (name) => parseFloat((name.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
const SPECIAL = /tts|image|live|audio|embedding|vision|native|computer/;

/** From a list of model names, choose the newest general-purpose Flash-Lite (or Flash). */
export function chooseModel(names) {
  const usable = names.filter((n) => /flash/.test(n) && !SPECIAL.test(n));
  const rank = (a, b) => version(b) - version(a)
    || /preview|exp/.test(a) - /preview|exp/.test(b) // prefer stable
    || a.length - b.length; // prefer the plain name over dated variants
  return usable.filter((n) => /flash-lite/.test(n)).sort(rank)[0] || usable.sort(rank)[0] || null;
}

/** Names of models this API key can call generateContent on. */
export async function listGenerateModels(client, abortSignal) {
  const names = [];
  const pager = await client.models.list({ config: { pageSize: 100, abortSignal } });
  for await (const m of pager) {
    if ((m.supportedActions || []).includes('generateContent')) names.push(m.name.replace(/^models\//, ''));
  }
  return names;
}

let pickedModel; // cached per server instance
/** The model to use: GEMINI_MODEL if set, else the newest Flash-Lite the key can use. */
export async function pickDefaultModel(client) {
  if (DEFAULT_MODEL) return DEFAULT_MODEL;
  pickedModel ??= (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        return chooseModel(await listGenerateModels(client, controller.signal)) || FALLBACK_MODEL;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      console.warn('Could not list Gemini models, using', FALLBACK_MODEL, err?.message);
      pickedModel = undefined; // try again next time
      return FALLBACK_MODEL;
    }
  })();
  return pickedModel;
}

/**
 * Timing/trace info filled in while a story streams. All *Ms values are
 * milliseconds since `t0` (the moment streamStory started, unless the caller
 * passes its own t0).
 */
export function newTrace(t0 = Date.now()) {
  return {
    t0,
    model: null,
    thinkingLevel: null,
    modelPickMs: null, // time spent choosing the model (listing models), first request only
    geminiRequestMs: null, // request sent to Google
    geminiResponseMs: null, // Google's HTTP response headers arrived
    geminiStatus: null,
    firstChunkMs: null, // first streamed chunk of any kind (thinking or text)
    firstThoughtMs: null,
    firstTextMs: null, // first story text
    doneMs: null,
    chunks: 0,
    thoughtChunks: 0,
    modelVersion: null,
    promptTokens: null,
    thoughtsTokens: null,
    outputTokens: null,
    error: null,
  };
}

/**
 * Stream a story. Yields text chunks as the model writes them.
 * @param {object} input  { name, age, topic, minutes }
 * @param {object} [opts] { apiKey, model, promptVersion, temperature, thinkingLevel, timeoutMs,
 *                          firstChunkTimeoutMs, client, trace, onProgress(trace, event) }
 *   trace: an object from newTrace() to fill in with timings.
 *   onProgress: called with 'gemini-request', 'gemini-response', 'thinking', 'writing'.
 */
export async function* streamStory(input, opts = {}) {
  const params = normalizeInput(input);
  const trace = opts.trace || newTrace();
  const since = () => Date.now() - trace.t0;
  const progress = (event) => { try { opts.onProgress?.(trace, event); } catch {} };

  // Wrap fetch so we can see when Google actually answers, separately from
  // when the first story text arrives.
  const tracingFetch = async (url, init) => {
    if (!/:streamGenerateContent/.test(String(url))) return globalThis.fetch(url, init);
    trace.geminiRequestMs = since();
    progress('gemini-request');
    const res = await globalThis.fetch(url, init);
    trace.geminiResponseMs = since();
    trace.geminiStatus = res.status;
    progress('gemini-response');
    return res;
  };
  const client = opts.client || new GoogleGenAI({
    apiKey: opts.apiKey || process.env.GEMINI_API_KEY,
    httpOptions: { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, fetch: tracingFetch },
  });

  // Flash-Lite models think little by default, so leave their setting alone
  // unless one is asked for. Other models get LOW to keep them quick.
  const pickStart = Date.now();
  const model = opts.model || await pickDefaultModel(client);
  trace.modelPickMs = Date.now() - pickStart;

  const thinkingLevel = opts.thinkingLevel || process.env.GEMINI_THINKING_LEVEL || (/lite/.test(model) ? null : 'LOW');
  trace.model = model;
  trace.thinkingLevel = thinkingLevel || 'model default';

  const firstChunkTimeoutMs = opts.firstChunkTimeoutMs ?? DEFAULT_FIRST_CHUNK_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), firstChunkTimeoutMs);
  let any = false;
  try {
    const stream = await client.models.generateContentStream({
      model,
      contents: buildPrompt(params, opts.promptVersion),
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: opts.temperature ?? 0.9,
        // includeThoughts streams the model's thinking too (kept out of the story
        // text) so we can see whether a slow start is thinking or waiting.
        ...(thinkingLevel ? { thinkingConfig: { ...thinkingConfig(model, thinkingLevel), includeThoughts: true } } : {}),
        abortSignal: controller.signal,
      },
    });
    for await (const chunk of stream) {
      trace.chunks++;
      if (trace.firstChunkMs === null) trace.firstChunkMs = since();
      if (chunk.modelVersion) trace.modelVersion = chunk.modelVersion;
      const u = chunk.usageMetadata;
      if (u) {
        trace.promptTokens = u.promptTokenCount ?? trace.promptTokens;
        trace.thoughtsTokens = u.thoughtsTokenCount ?? trace.thoughtsTokens;
        trace.outputTokens = u.candidatesTokenCount ?? trace.outputTokens;
      }
      const parts = chunk.candidates?.[0]?.content?.parts || [];
      if (parts.some((p) => p.thought)) {
        trace.thoughtChunks++;
        if (trace.firstThoughtMs === null) { trace.firstThoughtMs = since(); progress('thinking'); }
      }
      const text = chunk.text;
      if (text) {
        if (!any) { clearTimeout(timer); trace.firstTextMs = since(); progress('writing'); }
        any = true;
        yield text;
      }
    }
  } catch (err) {
    const out = controller.signal.aborted && !any ? timeoutError(firstChunkTimeoutMs) : err;
    trace.error = `${out.name}: ${String(out.message).slice(0, 300)}`;
    throw out;
  } finally {
    clearTimeout(timer);
    trace.doneMs = since();
  }
  if (!any) {
    trace.error = 'empty response';
    throw new Error('The model returned an empty response (it may have been blocked by safety filters).');
  }
}

function timeoutError(ms) {
  const e = new Error(`Gemini sent no story text for ${Math.round(ms / 1000)}s.`);
  e.name = 'TimeoutError';
  return e;
}

/**
 * Generate a whole story (uses the same streaming path as the web app).
 * @returns {Promise<{title, body, wordCount, targetWords, model, prompt, latencyMs, firstChunkMs, trace}>}
 */
export async function generateStory(input, opts = {}) {
  const params = normalizeInput(input);
  const started = Date.now();
  const trace = opts.trace || newTrace(started);
  let text = '';
  for await (const chunk of streamStory(params, { ...opts, trace })) text += chunk;
  const { title, body } = parseStory(text);
  return {
    title,
    body,
    wordCount: countWords(body),
    targetWords: targetWordCount(params.minutes),
    model: trace.model,
    prompt: buildPrompt(params, opts.promptVersion),
    latencyMs: Date.now() - started,
    firstChunkMs: trace.firstTextMs,
    trace,
  };
}
