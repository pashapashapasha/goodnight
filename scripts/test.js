// Offline checks for lib/story.js using a fake Gemini client (no API key needed).
import assert from 'node:assert/strict';
import { normalizeInput, buildPrompt, parseStory, generateStory, targetWordCount } from '../lib/story.js';

assert.throws(() => normalizeInput({ name: '', age: 5, topic: 'x', minutes: 3 }), /Name/);
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
