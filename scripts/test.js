// Offline checks for lib/story.js using a fake Gemini client (no API key needed).
import assert from 'node:assert/strict';
import { normalizeInput, buildPrompt, parseStory, generateStory, targetWordCount } from '../lib/story.js';

// Everything is optional; given values are still checked.
assert.deepEqual(normalizeInput({}), { name: '', age: null, topic: '', minutes: 5 });
assert.deepEqual(normalizeInput({ name: '', age: '', topic: '  ', minutes: '' }), { name: '', age: null, topic: '', minutes: 5 });
const blankPrompt = buildPrompt(normalizeInput({}));
assert.match(blankPrompt, /name: not given/);
assert.match(blankPrompt, /age: not given/);
assert.match(blankPrompt, /Topic: your choice/);
assert.match(blankPrompt, /about 650 words/);
assert.throws(() => normalizeInput({ name: 'x'.repeat(41) }), /Name/);
assert.throws(() => normalizeInput({ name: 'A', age: 40, topic: 'x', minutes: 3 }), /Age/);
assert.throws(() => normalizeInput({ name: 'A', age: 5, topic: 'x', minutes: 99 }), /Length/);
assert.deepEqual(normalizeInput({ name: ' Maya ', age: '4', topic: 'dragons', minutes: '5' }),
  { name: 'Maya', age: 4, topic: 'dragons', minutes: 5 });

assert.match(buildPrompt({ name: 'Maya', age: 4, topic: 'dragons', minutes: 5 }), /about 650 words/);
assert.deepEqual(parseStory('# The Moon\n\nOnce upon a time.'), { title: 'The Moon', body: 'Once upon a time.' });
assert.equal(parseStory('No title here').title, 'A Bedtime Story');

const fake = { models: { generateContentStream: async (req) => {
  assert.equal(req.model, 'test-model');
  assert.equal(req.config.thinkingConfig.thinkingLevel, 'LOW');
  assert.equal(req.config.thinkingConfig.includeThoughts, true);
  return (async function* () {
    yield { text: '# Sleepy\n\nMaya ' };
    yield { candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] } }], text: undefined }; // thinking is not story text
    yield { text: 'yawned. Goodnight.' };
  })();
} } };
const s = await generateStory({ name: 'Maya', age: 4, topic: 'x', minutes: 2 }, { client: fake, model: 'test-model' });
assert.equal(s.title, 'Sleepy');
assert.equal(s.wordCount, 3);
assert.equal(s.targetWords, targetWordCount(2));
assert.equal(s.trace.chunks, 3);
assert.equal(s.trace.thoughtChunks, 1);
assert.ok(s.trace.firstTextMs !== null && s.trace.doneMs !== null);

// Flash-Lite models get no thinking setting by default.
const lite = { models: { generateContentStream: async (req) => {
  assert.equal(req.config.thinkingConfig, undefined);
  return (async function* () { yield { text: '# T\n\nHi.' }; })();
} } };
await generateStory({ name: 'Maya', age: 4, topic: 'x', minutes: 2 }, { client: lite, model: 'gemini-flash-lite-latest' });

const empty = { models: { generateContentStream: async () => (async function* () {})() } };
await assert.rejects(generateStory({ name: 'Maya', age: 4, topic: 'x', minutes: 2 }, { client: empty }), /empty response/);

console.log('all tests passed');

// Model picking: newest stable general-purpose Flash-Lite, else newest Flash.
import { chooseModel } from '../lib/story.js';
assert.equal(chooseModel([
  'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.7-flash-lite', 'gemini-3.7-flash-lite-preview-09-2026',
  'gemini-3.8-flash-lite-tts', 'gemini-2.0-flash-lite', 'gemini-3.8-flash-image', 'gemini-3.7-flash-lite-001',
]), 'gemini-3.7-flash-lite');
assert.equal(chooseModel(['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.8-flash-tts']), 'gemini-3.8-flash');
assert.equal(chooseModel(['gemini-3.8-pro']), null);
console.log('model picking tests passed');

// Eval scorers.
import { lengthAccuracy, usesName, cleanFormat, makeStoryJudge, withRetry } from '../evals/scorers.js';
const words = (n) => Array(n).fill('word').join(' ');
assert.equal(lengthAccuracy({ input: { minutes: 1 }, output: { body: words(130) } }).score, 1);
assert.equal(lengthAccuracy({ input: { minutes: 1 }, output: { body: words(65) } }).score, 0);
assert.ok(Math.abs(lengthAccuracy({ input: { minutes: 1 }, output: { body: words(143) } }).score - 0.8) < 1e-9);
assert.equal(usesName({ input: { name: 'Maya' }, output: { body: 'Maya slept.' } }).score, 1);
assert.equal(usesName({ input: { name: 'Maya' }, output: { body: 'Leo slept.' } }).score, 0);
assert.equal(usesName({ input: {}, output: { body: 'Leo slept.' } }).score, null);
assert.equal(cleanFormat({ output: { title: 'T', body: 'a\n\nb\n\nc' } }).score, 1);
assert.deepEqual(cleanFormat({ output: { title: 'T', body: 'Here\'s a story!\n\n**b**\n\nc' } }).metadata.problems, ['markdown in body', 'preamble']);

const judgeClient = { models: { generateContent: async (req) => {
  assert.equal(req.config.responseMimeType, 'application/json');
  const r = (score) => ({ score, reason: 'x' });
  return { text: JSON.stringify({ safe: r(5), calming: r(1), winds_down: r(3), age_appropriate: r(5), on_topic: r(5), engaging: r(4) }) };
} } };
const judged = await makeStoryJudge({ client: judgeClient, model: 'm' })({ input: {}, output: { title: 'T', body: 'b' } });
assert.deepEqual(Object.fromEntries(judged.map((s) => [s.name, s.score])),
  { judge_safe: 1, judge_calming: 0, judge_winds_down: 0.5, judge_age_appropriate: 1, judge_on_topic: 1, judge_engaging: 0.75 });

let tries = 0;
const quiet = console.warn; console.warn = () => {};
assert.equal(await withRetry(async () => { if (++tries < 3) throw Object.assign(new Error('x'), { status: 429 }); return 'ok'; }, { waitMs: 1 }), 'ok');
await assert.rejects(withRetry(async () => { throw Object.assign(new Error('bad key'), { status: 400 }); }, { waitMs: 1 }), /bad key/);
console.warn = quiet;
console.log('scorer tests passed');
