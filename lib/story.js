// Story generation, kept separate from the UI so it can be called from the
// web API, the eval script, or a REPL.
import { GoogleGenAI } from '@google/genai';

export const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

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

/** Validate and normalise raw input. Throws an Error with a user-facing message. */
export function normalizeInput(raw = {}) {
  const name = String(raw.name ?? '').trim();
  const topic = String(raw.topic ?? '').trim();
  const age = Number(raw.age);
  const minutes = Number(raw.minutes);

  if (!name) throw new Error('Name is required.');
  if (name.length > LIMITS.nameMaxLength) throw new Error(`Name must be at most ${LIMITS.nameMaxLength} characters.`);
  if (!topic) throw new Error('Topic is required.');
  if (topic.length > LIMITS.topicMaxLength) throw new Error(`Topic must be at most ${LIMITS.topicMaxLength} characters.`);
  if (!Number.isInteger(age) || age < LIMITS.minAge || age > LIMITS.maxAge) {
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
- The child is the main character, referred to by their name.
- Hit the requested word count closely; it determines how long the story takes to read.
- Output format: a title on the first line prefixed with "# ", a blank line, then the story in plain paragraphs. No other markdown, no notes, no preamble.`;

export function buildPrompt({ name, age, topic, minutes }) {
  const words = targetWordCount(minutes);
  return `Write a bedtime story.
Child's name: ${name}
Child's age: ${age}
Topic: ${topic}
Target length: about ${words} words (roughly ${minutes} minute${minutes === 1 ? '' : 's'} read aloud). Stay within 10% of this.`;
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

/**
 * Generate a story.
 * @param {object} input  { name, age, topic, minutes }
 * @param {object} [opts] { apiKey, model, temperature, client }
 * @returns {Promise<{title, body, wordCount, targetWords, model, prompt, latencyMs}>}
 */
export async function generateStory(input, opts = {}) {
  const params = normalizeInput(input);
  const model = opts.model || DEFAULT_MODEL;
  const client = opts.client || new GoogleGenAI({ apiKey: opts.apiKey || process.env.GEMINI_API_KEY });
  const prompt = buildPrompt(params);

  const started = Date.now();
  const response = await client.models.generateContent({
    model,
    contents: prompt,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      temperature: opts.temperature ?? 0.9,
    },
  });
  const latencyMs = Date.now() - started;

  const text = response.text;
  if (!text) throw new Error('The model returned an empty response (it may have been blocked by safety filters).');

  const { title, body } = parseStory(text);
  return {
    title,
    body,
    wordCount: countWords(body),
    targetWords: targetWordCount(params.minutes),
    model,
    prompt,
    latencyMs,
  };
}
