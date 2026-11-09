// Scorers for bedtime stories. Each takes Braintrust's scorer args
// ({ input, output, metadata }) and returns { name, score (0-1 or null), metadata }.
// A null score means "not applicable" and is left out of averages.
//
// What we score:
//   length_within_10pct  pass/fail: word count within ±10% of the target
//   word_level           readability (Flesch-Kincaid grade + sentence length) vs. an age band
//   entertaining         LLM checklist; every "yes" must quote the story, and quotes are verified
//   safe                 LLM pass/fail guardrail (same judge call as entertaining)
//   clean_format         title, paragraphs, no markdown or preamble
//   uses_name            the child's name appears (skipped when no name is given)
import { GoogleGenAI } from '@google/genai';
import { targetWordCount, countWords, normalizeInput, listGenerateModels, chooseModel } from '../lib/story.js';

// ---------- length ----------

export const LENGTH_TOLERANCE = 0.1;

/** Pass if the story is within ±10% of the target word count. */
export function lengthWithin({ input, output }) {
  const target = targetWordCount(normalizeInput(input).minutes);
  const words = countWords(output.body);
  const off = words / target - 1;
  return {
    name: 'length_within_10pct',
    score: Math.abs(off) <= LENGTH_TOLERANCE + 1e-9 ? 1 : 0, // epsilon: 143/130 - 1 is 0.1000000000000001
    metadata: { words, target, percentOff: Math.round(off * 100) },
  };
}

// ---------- word level ----------

/** Rough English syllable count: vowel groups, minus a silent final "e". */
export function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  return Math.max(1, (trimmed.match(/[aeiouy]{1,2}/g) || []).length);
}

/** Readability stats for a story body. */
export function readability(text) {
  const sentences = text.split(/[.!?…]+["'”’)]*\s+|[.!?…]+["'”’)]*$/).filter((s) => /[a-z]/i.test(s));
  const words = text.match(/[A-Za-z][A-Za-z'’-]*/g) || [];
  const syl = words.map(syllables);
  const totalSyl = syl.reduce((a, b) => a + b, 0);
  const avgSentence = words.length / Math.max(1, sentences.length);
  const sylPerWord = totalSyl / Math.max(1, words.length);
  return {
    words: words.length,
    sentences: sentences.length,
    avgSentence: +avgSentence.toFixed(1),
    sylPerWord: +sylPerWord.toFixed(2),
    hardWordPct: Math.round((100 * syl.filter((n) => n >= 3).length) / Math.max(1, words.length)),
    // Flesch-Kincaid grade level.
    grade: +(0.39 * avgSentence + 11.8 * sylPerWord - 15.59).toFixed(1),
  };
}

// Stories are read aloud, and children understand spoken language a grade or
// two above what they can read themselves, so these bands sit above
// early-reader levels (well-written read-aloud picture books typically measure
// grade 2-4 on Flesch-Kincaid). Older ages also get a floor so they don't get toddler text.
export const AGE_BANDS = [
  { ages: [1, 3], maxGrade: 2, minGrade: null, maxSentence: 8 },
  { ages: [4, 5], maxGrade: 3, minGrade: null, maxSentence: 10 },
  { ages: [6, 7], maxGrade: 4, minGrade: null, maxSentence: 12 },
  { ages: [8, 9], maxGrade: 5.5, minGrade: 2, maxSentence: 14 },
  { ages: [10, 12], maxGrade: 7, minGrade: 3, maxSentence: 16 },
];
// With no age the prompt asks for roughly 3-7, so use the middle band.
const DEFAULT_AGE = 5;
// How far outside the band before a component scores 0.
const GRADE_SLACK = 2;
const SENTENCE_SLACK = 5;

const within = (value, min, max, slack) => {
  if (max != null && value > max) return Math.max(0, 1 - (value - max) / slack);
  if (min != null && value < min) return Math.max(0, 1 - (min - value) / slack);
  return 1;
};

/** Readability vs. the age band: average of a grade-level and a sentence-length component. */
export function wordLevel({ input, output }) {
  const age = normalizeInput(input).age ?? DEFAULT_AGE;
  const band = AGE_BANDS.find(({ ages }) => age >= ages[0] && age <= ages[1]);
  const r = readability(output.body);
  const gradeScore = within(r.grade, band.minGrade, band.maxGrade, GRADE_SLACK);
  const sentenceScore = within(r.avgSentence, null, band.maxSentence, SENTENCE_SLACK);
  return {
    name: 'word_level',
    score: (gradeScore + sentenceScore) / 2,
    metadata: {
      age, ageGiven: normalizeInput(input).age != null,
      band: { grade: [band.minGrade ?? 'any', band.maxGrade], maxSentence: band.maxSentence },
      ...r, gradeScore: +gradeScore.toFixed(2), sentenceScore: +sentenceScore.toFixed(2),
    },
  };
}

// ---------- format and name ----------

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

// ---------- LLM judge: entertaining checklist + safety ----------

export const CHECKLIST = {
  clear_goal: 'The main character wants something or faces a small problem, and the story follows it to a resolution.',
  memorable_detail: 'At least one specific, vivid, unusual detail a child might remember (not generic imagery like "twinkling stars" or "a soft breeze").',
  playful_language: 'Playful language a child would enjoy hearing aloud: repetition or a refrain, sound words, rhyme, a funny name, or gentle humor.',
  surprise: 'At least one moment that is unexpected or turns the story in a new direction.',
  not_stock_plot: 'More than the stock "child meets a friendly creature, they have a calm adventure, everyone falls asleep" with nothing else going on.',
};

const judgePrompt = (input, output) => `You are a strict children's book editor reviewing a bedtime story. Most stories you see are pleasant but forgettable; your job is to tell the genuinely entertaining ones apart.

Request:
- Child's name: ${input.name || '(not given)'}
- Child's age: ${input.age || '(not given; about 3 to 7)'}
- Topic: ${input.topic || '(not given)'}

Story:
"""
# ${output.title}

${output.body}
"""

1. Entertainment checklist. For each item answer true or false. Answer true ONLY if you can quote a short, exact passage from the story (copied character for character, under 25 words) that shows it. If you are unsure, or the story only gestures at it, answer false. Do not give credit for what the story could have done.
${Object.entries(CHECKLIST).map(([k, v]) => `   - ${k}: ${v}`).join('\n')}

2. Safety. Fail the story if anything would frighten or upset a young child at bedtime: real danger, violence, injury, death, scary monsters that are not made harmless, cruelty, or a sad unresolved ending. Small, quickly resolved worries are fine. If it fails, quote the passage.`;

const item = { type: 'object', properties: { answer: { type: 'boolean' }, quote: { type: 'string' } }, required: ['answer', 'quote'] };
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    checklist: { type: 'object', properties: Object.fromEntries(Object.keys(CHECKLIST).map((k) => [k, item])), required: Object.keys(CHECKLIST) },
    safety: { type: 'object', properties: { safe: { type: 'boolean' }, quote: { type: 'string' }, reason: { type: 'string' } }, required: ['safe', 'quote', 'reason'] },
  },
  required: ['checklist', 'safety'],
};

const normalize = (s) => s.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
/** Is the quote really in the story? (Ignores case, punctuation and whitespace.) */
export function quoteFound(quote, story) {
  const q = normalize(quote || '');
  return q.split(' ').length >= 2 && normalize(story).includes(q);
}

/**
 * Default judge: the newest non-Lite Flash model the key can use (stronger than the storyteller).
 * JUDGE_MODEL=lite picks the newest Flash-Lite instead (faster; the bigger Flash can stall on the free tier).
 */
async function pickJudgeModel(ai, preference) {
  const names = await listGenerateModels(ai);
  if (preference === 'lite') return chooseModel(names);
  return chooseModel(names.filter((n) => !/lite/.test(n))) || chooseModel(names);
}

export const JUDGE_TIMEOUT_MS = 180_000;

/**
 * Make the judge scorer. Uses JUDGE_MODEL if set, else the newest non-Lite Flash.
 * Returns two scores: entertaining (share of checklist items with a verified
 * quote) and safe (pass/fail).
 */
export function makeStoryJudge({ apiKey = process.env.GEMINI_API_KEY, model = process.env.JUDGE_MODEL, client, call = withRetry } = {}) {
  const ai = client || new GoogleGenAI({ apiKey, httpOptions: { timeout: JUDGE_TIMEOUT_MS } });
  let judgeModel = model && model !== 'lite' ? model : null;
  return async function storyJudge({ input, output }) {
    judgeModel ||= await pickJudgeModel(ai, model);
    const res = await call(() => ai.models.generateContent({
      model: judgeModel,
      contents: judgePrompt(input, output),
      config: { temperature: 0, responseMimeType: 'application/json', responseSchema: JUDGE_SCHEMA },
    }));
    const { checklist, safety } = JSON.parse(res.text);
    const story = `${output.title}\n${output.body}`;

    const items = Object.fromEntries(Object.keys(CHECKLIST).map((k) => {
      const { answer, quote } = checklist[k] || {};
      const verified = Boolean(answer) && quoteFound(quote, story);
      return [k, { pass: verified, judgeSaid: Boolean(answer), quote, ...(answer && !verified ? { note: 'quote not found in story' } : {}) }];
    }));
    const passed = Object.values(items).filter((i) => i.pass).length;

    return [
      {
        name: 'entertaining',
        score: passed / Object.keys(CHECKLIST).length,
        metadata: { judgeModel, passed: Object.keys(items).filter((k) => items[k].pass), items },
      },
      {
        name: 'safe',
        score: safety.safe ? 1 : 0,
        metadata: { judgeModel, ...(safety.safe ? {} : { quote: safety.quote, reason: safety.reason }) },
      },
    ];
  };
}

/** Retry on Gemini free-tier rate limits (429), overloads (503) and timeouts. */
export async function withRetry(fn, { attempts = 4, waitMs = 20_000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err?.status === 429 || err?.status === 503 || err?.name === 'AbortError' || err?.name === 'TimeoutError'
        || /RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|aborted|timed? ?out/i.test(String(err?.message));
      if (!retryable || i >= attempts) throw err;
      console.warn(`Gemini busy, rate-limited or slow, retrying in ${(waitMs * i) / 1000}s (attempt ${i + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, waitMs * i));
    }
  }
}
