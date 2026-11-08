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
import { lengthWithin, wordLevel, readability, usesName, cleanFormat, makeStoryJudge, withRetry, quoteFound } from '../evals/scorers.js';
const words = (n) => Array(n).fill('word').join(' ');
assert.equal(lengthWithin({ input: { minutes: 1 }, output: { body: words(130) } }).score, 1);
assert.equal(lengthWithin({ input: { minutes: 1 }, output: { body: words(143) } }).score, 1); // +10%
assert.equal(lengthWithin({ input: { minutes: 1 }, output: { body: words(144) } }).score, 0);
assert.equal(lengthWithin({ input: { minutes: 1 }, output: { body: words(117) } }).metadata.percentOff, -10);

const simple = 'Leo has a bear. The bear is soft. Leo hugs the bear. Night night, bear.';
const dense = 'Beneath the city, where the subway trains rumbled like distant thunder, Priya discovered a library that no map had ever recorded, illuminated by lanterns that flickered whenever someone turned a page.';
assert.equal(readability(simple).sentences, 4);
assert.equal(wordLevel({ input: { age: 3 }, output: { body: simple } }).score, 1);
assert.equal(wordLevel({ input: { age: 4 }, output: { body: dense } }).score, 0);
assert.ok(wordLevel({ input: { age: 11 }, output: { body: simple } }).score < 1); // too simple for 11
assert.equal(wordLevel({ input: {}, output: { body: simple } }).metadata.age, 5); // no age -> middle band

assert.equal(usesName({ input: { name: 'Maya' }, output: { body: 'Maya slept.' } }).score, 1);
assert.equal(usesName({ input: { name: 'Maya' }, output: { body: 'Leo slept.' } }).score, 0);
assert.equal(usesName({ input: {}, output: { body: 'Leo slept.' } }).score, null);
assert.equal(cleanFormat({ output: { title: 'T', body: 'a\n\nb\n\nc' } }).score, 1);
assert.deepEqual(cleanFormat({ output: { title: 'T', body: 'Here\'s a story!\n\n**b**\n\nc' } }).metadata.problems, ['markdown in body', 'preamble']);

assert.ok(quoteFound('the dragon snored, like a "teakettle"', 'Then the Dragon snored like a teakettle!'));
assert.ok(!quoteFound('the dragon sang', 'Then the dragon snored.'));
assert.ok(!quoteFound('dragon', 'dragon')); // single words are too easy to match

const story = { title: 'Toast', body: 'Maya found a dragon the color of toast.\n\nHe snored like a teakettle.\n\nGoodnight.' };
const judgeClient = { models: { generateContent: async (req) => {
  assert.equal(req.config.responseMimeType, 'application/json');
  return { text: JSON.stringify({
    checklist: {
      clear_goal: { answer: false, quote: '' },
      memorable_detail: { answer: true, quote: 'a dragon the color of toast' },  // real quote
      playful_language: { answer: true, quote: 'snored like a teakettle' },       // real quote
      surprise: { answer: true, quote: 'the dragon flew to the moon' },          // made up -> no credit
      not_stock_plot: { answer: true, quote: '' },                               // no quote -> no credit
    },
    safety: { safe: true, quote: '', reason: '' },
  }) };
} } };
const judged = await makeStoryJudge({ client: judgeClient, model: 'm' })({ input: {}, output: story });
const byName = Object.fromEntries(judged.map((x) => [x.name, x]));
assert.equal(byName.entertaining.score, 2 / 5);
assert.deepEqual(byName.entertaining.metadata.passed, ['memorable_detail', 'playful_language']);
assert.equal(byName.entertaining.metadata.items.surprise.note, 'quote not found in story');
assert.equal(byName.safe.score, 1);

let tries = 0;
const quiet = console.warn; console.warn = () => {};
assert.equal(await withRetry(async () => { if (++tries < 3) throw Object.assign(new Error('x'), { status: 429 }); return 'ok'; }, { waitMs: 1 }), 'ok');
await assert.rejects(withRetry(async () => { throw Object.assign(new Error('bad key'), { status: 400 }); }, { waitMs: 1 }), /bad key/);
console.warn = quiet;
console.log('scorer tests passed');
