import { streamStory, normalizeInput, parseStory, countWords, targetWordCount } from '../lib/story.js';

// Response is newline-delimited JSON so the page can show the story as it is written:
//   {"type":"text","text":"..."}   (many)
//   {"type":"done","wordCount":N,"targetWords":N}
//   {"type":"error","error":"..."}  (if generation fails part-way)
// Input errors before streaming starts are returned as a normal JSON 4xx/5xx.

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (err?.status === 429 || /RESOURCE_EXHAUSTED|429/.test(msg)) {
    return { status: 429, error: 'Gemini free-tier rate limit hit. Wait a minute and try again.' };
  }
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || /timed? ?out|aborted/i.test(msg)) {
    return { status: 504, error: 'Gemini took too long to respond. Try again, or pick a shorter story.' };
  }
  if (err?.status === 404 || /not found/i.test(msg)) {
    return { status: 502, error: 'The Gemini model was not found. Check the GEMINI_MODEL setting.' };
  }
  if (err?.status === 400 && /API key/i.test(msg)) {
    return { status: 500, error: 'The Gemini API key is invalid. Check GEMINI_API_KEY.' };
  }
  return { status: 502, error: 'Story generation failed. Please try again.' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set on the server.' });
  }

  let input;
  try {
    input = normalizeInput(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const started = Date.now();
  const elapsed = () => `${Date.now() - started}ms`;
  console.log(`story: calling Gemini (model=${process.env.GEMINI_MODEL || 'default'}, minutes=${input.minutes})`);
  const chunks = streamStory(input);
  let first;
  try {
    // Wait for the first chunk so early failures still get a proper status code.
    first = await chunks.next();
    console.log(`story: first text after ${elapsed()}`);
  } catch (err) {
    console.error(`story: failed after ${elapsed()}:`, err);
    const { status, error } = friendlyError(err);
    return res.status(status).json({ error });
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  let text = '';
  try {
    if (!first.done) { text += first.value; send({ type: 'text', text: first.value }); }
    for await (const chunk of chunks) {
      text += chunk;
      send({ type: 'text', text: chunk });
    }
    console.log(`story: finished after ${elapsed()}`);
    send({ type: 'done', wordCount: countWords(parseStory(text).body), targetWords: targetWordCount(input.minutes) });
  } catch (err) {
    console.error(`story: failed mid-stream after ${elapsed()}:`, err);
    send({ type: 'error', error: friendlyError(err).error });
  }
  res.end();
}
