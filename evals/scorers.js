// Scorers for bedtime stories. Each takes Braintrust's scorer args
// ({ input, output, metadata }) and returns { name, score (0-1 or null), metadata }.
// A null score means "not applicable" and is left out of averages.
import { GoogleGenAI } from '@google/genai';
import { targetWordCount, countWords, normalizeInput, pickDefaultModel } from '../lib/story.js';

/** 1.0 when the word count hits the target; 0 when it is 50% or more off. */
export function lengthAccuracy({ input, output }) {
  const target = targetWordCount(normalizeInput(input).minutes);
  const words = countWords(output.body);
  const ratio = words / target;
  return {
    name: 'length_accuracy',
    score: Math.max(0, 1 - Math.abs(ratio - 1) / 0.5),
    metadata: { words, target, ratio: +ratio.toFixed(2) },
  };
}

/** Does the story use the child's name? Not applicable when no name was given. */
export function usesName({ input, output }) {
  const name = normalizeInput(input).name;
  if (!name) return { name: 'uses_name', score: null };
  const count = output.body.split(name).length - 1;
  return { name: 'uses_name', score: count > 0 ? 1 : 0, metadata: { mentions: count } };
}

/** Title present, several paragraphs, no leftover markdown or chatter. */
export function cleanFormat({ output }) {
  const problems = [];
  if (!output.title || output.title === 'A Bedtime Story') problems.push('no title');
  const paragraphs = output.body.split(/\n\s*\n/).filter((p) => p.trim()).length;
  if (paragraphs < 3) problems.push(`only ${paragraphs} paragraph(s)`);
  if (/[*_]{2}|^#{1,6}\s|^[-*]\s/m.test(output.body)) problems.push('markdown in body');
  if (/^(sure|here('|’)s|okay)\b/i.test(output.body.trim())) problems.push('preamble');
  return { name: 'clean_format', score: problems.length ? 0 : 1, metadata: { problems, paragraphs } };
}

// ---------- LLM judge (Gemini) ----------

const CRITERIA = {
  safe: 'Nothing scary, violent, sad or upsetting for a young child. Any conflict is small and resolves kindly.',
  calming: 'Gentle, warm, unhurried tone and pacing suitable for bedtime.',
  winds_down: 'The ending settles toward rest or sleep.',
  age_appropriate: 'Vocabulary, sentence length and ideas suit the child\'s age (about 3 to 7 if no age is given).',
  on_topic: 'Follows the requested topic (any topic is fine if none was requested).',
  engaging: 'Has a simple, coherent story with a little wonder or charm that a child would enjoy.',
};

const JUDGE_PROMPT = (input, output) => `You are reviewing a bedtime story written for a young child.

Request:
- Child's name: ${input.name || '(not given)'}
- Child's age: ${input.age || '(not given)'}
- Topic: ${input.topic || '(not given)'}

Story:
# ${output.title}

${output.body}

Rate the story from 1 (poor) to 5 (excellent) on each criterion, with a one-sentence reason:
${Object.entries(CRITERIA).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;

const JUDGE_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(Object.keys(CRITERIA).map((k) => [k, {
    type: 'object',
    properties: { score: { type: 'integer', minimum: 1, maximum: 5 }, reason: { type: 'string' } },
    required: ['score', 'reason'],
  }])),
  required: Object.keys(CRITERIA),
};

/**
 * Make a judge scorer. Uses JUDGE_MODEL if set, else the same model the app picks.
 * Returns one score per criterion, scaled from 1-5 to 0-1.
 */
export function makeStoryJudge({ apiKey = process.env.GEMINI_API_KEY, model = process.env.JUDGE_MODEL, client, call = withRetry } = {}) {
  const ai = client || new GoogleGenAI({ apiKey });
  return async function storyJudge({ input, output }) {
    const judgeModel = model || await pickDefaultModel(ai);
    const res = await call(() => ai.models.generateContent({
      model: judgeModel,
      contents: JUDGE_PROMPT(input, output),
      config: { temperature: 0, responseMimeType: 'application/json', responseSchema: JUDGE_SCHEMA },
    }));
    const ratings = JSON.parse(res.text);
    return Object.keys(CRITERIA).map((k) => ({
      name: `judge_${k}`,
      score: (Math.min(5, Math.max(1, ratings[k].score)) - 1) / 4,
      metadata: { rating: ratings[k].score, reason: ratings[k].reason, judgeModel },
    }));
  };
}

/** Retry on Gemini free-tier rate limits (429) and overloads (503). */
export async function withRetry(fn, { attempts = 4, waitMs = 20_000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err?.status === 429 || err?.status === 503 || /RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded/i.test(String(err?.message));
      if (!retryable || i >= attempts) throw err;
      console.warn(`Gemini busy or rate-limited, retrying in ${(waitMs * i) / 1000}s (attempt ${i + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, waitMs * i));
    }
  }
}
