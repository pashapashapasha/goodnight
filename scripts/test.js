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

const fake = { models: { generateContent: async (req) => {
  assert.equal(req.model, 'test-model');
  return { text: '# Sleepy\n\nMaya yawned. Goodnight.' };
} } };
const s = await generateStory({ name: 'Maya', age: 4, topic: 'x', minutes: 2 }, { client: fake, model: 'test-model' });
assert.equal(s.title, 'Sleepy');
assert.equal(s.wordCount, 3);
assert.equal(s.targetWords, targetWordCount(2));

console.log('all tests passed');
