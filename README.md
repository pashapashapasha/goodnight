# Goodnight

A small web app that writes a bedtime story from a child's name, age, topic and reading time, using the Gemini API. Hosted on Vercel.

## Layout

| Path | What it is |
| --- | --- |
| `lib/story.js` | All story generation: input validation, prompt, Gemini call, output parsing. No UI or HTTP code. |
| `api/story.js` | Vercel serverless function: `POST /api/story` → streams the story back as it is written (newline-delimited JSON). |
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

`streamStory(input)` is the same thing as an async iterator of text chunks (what the web app uses).

Settings (env vars, or options to `generateStory`/`streamStory`):

| Env var | Option | Default | |
| --- | --- | --- | --- |
| `GEMINI_MODEL` | `model` | `gemini-3.8-flash` | Which Gemini model to use. |
| `GEMINI_THINKING_LEVEL` | `thinkingLevel` | `LOW` | `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`. Higher is slower; stories rarely benefit. |
| | `timeoutMs` | `240000` | Gives up on Gemini after this long. |

The eval results include `firstChunkMs` (time until text starts appearing) and `latencyMs` (time for the whole story).

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

`vercel.json` allows the story function to run for up to 300 seconds. This needs Fluid Compute, which is on by default for new projects (Project → Settings → Functions). If a deploy fails with a `maxDuration` error, turn Fluid Compute on, or lower the value to 60.

The API key only lives on the server; the browser never sees it.

## Troubleshooting

After every story (or failure) the page shows **Where the time went**: when the request reached the server, when it was sent to Gemini, when Gemini replied, when it started thinking, when the first story words arrived and when it finished, plus the model version, token counts (including thinking tokens) and any error. The same trace is logged in the Vercel project's Logs tab (`story: done {...}` / `story: failed {...}`) and included in eval results.

`/api/health` runs a few tiny Gemini requests with the deployed key and a speed comparison of model/thinking setups. Each visit uses a little of your Gemini quota.
