# Goodnight

A small web app that writes a bedtime story from a child's name, age, topic and reading time, using the Gemini API. Hosted on Vercel.

## Layout

| Path | What it is |
| --- | --- |
| `lib/story.js` | All story generation: input validation, prompt, Gemini call, output parsing. No UI or HTTP code. |
| `api/story.js` | Vercel serverless function: `POST /api/story` → calls `generateStory`. |
| `public/index.html` | The UI (plain HTML/JS, no build step). |
| `evals/cases.json` | Test inputs for evaluating generation. |
| `scripts/eval.js` | Runs the cases against Gemini and saves stories + metrics to `evals/runs/<timestamp>/`. |
| `scripts/test.js` | Offline unit tests using a fake Gemini client. |

Reading time is converted to a word target at 130 words/minute (read-aloud pace), set in `WORDS_PER_MINUTE`.

## Setup

1. Get a free API key at https://aistudio.google.com/apikey
2. Install dependencies (Node 22+):

```bash
npm install
```

## Evaluate the generator (no UI)

```bash
GEMINI_API_KEY=your-key npm run eval
```

Options: `--model <name>` to compare models, `--only toddler-short,space` to run some cases, `--delay 5000` (ms between calls, to stay under free-tier rate limits). Each run writes one `.md` per story plus `results.json` with word count vs. target, whether the child's name appears, and latency.

Or call it directly:

```js
import { generateStory } from './lib/story.js';
const s = await generateStory({ name: 'Maya', age: 4, topic: 'a sleepy dragon', minutes: 5 });
```

The model defaults to `gemini-3.8-flash`; override with the `GEMINI_MODEL` env var or the `model` option.

## Run locally

```bash
npm i -g vercel
```

```bash
GEMINI_API_KEY=your-key vercel dev
```

## Deploy to Vercel

1. Import this GitHub repo at https://vercel.com/new (framework preset: **Other**, no build command needed).
2. In Project → Settings → Environment Variables, add `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`).
3. Deploy. Pushes to the main branch redeploy automatically.

The API key only lives on the server; the browser never sees it.
