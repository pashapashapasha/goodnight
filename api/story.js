import { generateStory } from '../lib/story.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set on the server.' });
  }

  let story;
  try {
    story = await generateStory(req.body || {});
  } catch (err) {
    const isInput = /required|must be/i.test(err.message);
    const isRate = err.status === 429 || /RESOURCE_EXHAUSTED|429/.test(String(err.message));
    console.error(err);
    if (isInput) return res.status(400).json({ error: err.message });
    if (isRate) return res.status(429).json({ error: 'Gemini free-tier rate limit hit. Wait a minute and try again.' });
    return res.status(502).json({ error: 'Story generation failed. Please try again.' });
  }

  const { title, body, wordCount, targetWords } = story;
  return res.status(200).json({ title, body, wordCount, targetWords });
}
