import { streamStory, normalizeInput, parseStory, countWords, targetWordCount, newTrace } from '../lib/story.js';

// Response is newline-delimited JSON, sent as things happen so the page can
// show progress and where the time went:
//   {"type":"progress","stage":"server"|"gemini-request"|"gemini-response"|"thinking"|"writing","ms":N}
//   {"type":"text","text":"..."}   (many)
//   {"type":"done","wordCount":N,"targetWords":N,"timing":{...}}
//   {"type":"error","error":"...","timing":{...}}
// Bad input is rejected up front with a normal JSON 400.

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (err?.status === 429 || /RESOURCE_EXHAUSTED|429/.test(msg)) {
    return 'Gemini free-tier rate limit hit. Wait a minute and try again.';
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timed? ?out|aborted/i.test(msg)) {
    return 'Gemini took too long to respond.';
  }
  if (err?.status === 404 || /not found/i.test(msg)) {
    return process.env.GEMINI_MODEL
      ? `The Gemini model "${process.env.GEMINI_MODEL}" was not found. Check the GEMINI_MODEL setting in Vercel.`
      : 'The Gemini model was not found.';
  }
  if (err?.status === 400 && /API key/i.test(msg)) {
    return 'The Gemini API key is invalid. Check GEMINI_API_KEY.';
  }
  return 'Story generation failed. Please try again.';
}

export default async function handler(req, res) {
  const trace = newTrace();
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

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  const since = () => Date.now() - trace.t0;

  send({ type: 'progress', stage: 'server', ms: since() });
  const onProgress = (_trace, stage) => {
    send({ type: 'progress', stage, ms: since() });
    console.log(`story: ${stage} at ${since()}ms`);
  };

  let text = '';
  try {
    for await (const chunk of streamStory(input, { trace, onProgress })) {
      text += chunk;
      send({ type: 'text', text: chunk });
    }
    send({ type: 'done', wordCount: countWords(parseStory(text).body), targetWords: targetWordCount(input.minutes), timing: trace });
    console.log('story: done', JSON.stringify(trace));
  } catch (err) {
    console.error('story: failed', JSON.stringify(trace), err);
    send({ type: 'error', error: friendlyError(err), timing: trace });
  }
  res.end();
}
