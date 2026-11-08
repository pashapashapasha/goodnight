# Goodnight

A small web app that writes a bedtime story from a child's name, age, topic and reading time (all optional), using the Gemini API. Hosted on Vercel.

## Layout

| Path | What it is |
| --- | --- |
| `lib/story.js` | All story generation: input validation, prompt, Gemini call, output parsing. No UI or HTTP code. |
| `api/story.js` | Vercel serverless function: `POST /api/story` → streams the story back as it is written (newline-delimited JSON). |
| `public/index.html` | The UI (plain HTML/JS, no build step). |
| `evals/cases.json` | Test inputs for evaluating generation. |
| `evals/story.eval.js` | Braintrust eval: runs the cases and scores each story. |
| `evals/scorers.js` | Scorers: length, name use, format, and a Gemini judge. |
| `scripts/eval.js` | Simple local eval without Braintrust: saves stories + metrics to `evals/runs/<timestamp>/`. |
| `scripts/test.js` | Offline unit tests using a fake Gemini client. |

Reading time is converted to a word target at 130 words/minute (read-aloud pace), set in `WORDS_PER_MINUTE`.

## Setup

1. Get a free API key at https://aistudio.google.com/apikey
2. Install dependencies (Node 22+):

```bash
npm install
```

## Evaluate the generator with Braintrust

### From GitHub (no local setup)

1. Sign up at https://www.braintrust.dev (free tier) and create an API key under **Settings → API keys**.
2. In this GitHub repo, go to **Settings → Secrets and variables → Actions → New repository secret** and add `GEMINI_API_KEY` and `BRAINTRUST_API_KEY`.
3. Go to **Actions → Story evals → Run workflow**. Optionally fill in a model, judge model or number of trials.

The run's summary page shows the scores and a link to the experiment in Braintrust.

### Locally

1. Sign up at https://www.braintrust.dev (the free tier is enough) and create an API key under **Settings → API keys**.
2. Copy `.env.example` to `.env` and fill in `GEMINI_API_KEY` and `BRAINTRUST_API_KEY`. Or, if the keys are already set in Vercel, pull them with `vercel env pull .env.local` (both files are loaded, `.env.local` wins).
3. Run:

```bash
npm run eval:bt
```

This runs every case in `evals/cases.json` through the same `generateStory` the app uses, scores each story, and logs it as an experiment in a Braintrust project called `goodnight`. The CLI prints a link to it. Each run is a new experiment, so you can compare runs side by side after changing the prompt or model.

Scores (all 0–1):

| Score | How |
| --- | --- |
| `length_within_10pct` | Pass/fail: word count within ±10% of the target (130 words per minute). The actual % off is in the metadata. |
| `word_level` | Flesch-Kincaid grade and average sentence length vs. a band for the child's age (no age = ages 4–5 band). Partial credit near the band; 0 at 2 grades or 5 words per sentence outside it. Older ages also have a floor. Bands are in `AGE_BANDS` in `evals/scorers.js`. |
| `entertaining` | Share of 5 checklist items a strict judge says yes to: clear goal or problem, memorable specific detail, playful language, a surprise, more than a stock plot. Every yes must quote the story, and the quote is checked against the text; a missing or made-up quote counts as no. |
| `safe` | Pass/fail guardrail from the same judge call: nothing that would frighten or upset a young child. Fails include the quote and reason. |
| `clean_format` | Has a title, at least 3 paragraphs, no markdown or preamble. |
| `uses_name` | Story mentions the child's name (skipped when no name is given). |

The judge is the newest non-Lite Flash model your key can use (stronger than the Flash-Lite storyteller), unless `JUDGE_MODEL` is set.

Each case's metadata also records the model, word counts, latency and token counts.

Options, as env vars (or in `.env`):
- `EVAL_MODEL`: model to evaluate, to compare models.
- `JUDGE_MODEL`: model that grades. Defaults to the newest non-Lite Flash; set it to a Flash-Lite model if the bigger one is too slow on your key.
- `EVAL_TRIALS`: run each case several times to smooth out randomness.

Add `-- --no-send-logs` to run locally without logging to Braintrust. Cases run one at a time and retry on rate limits, to stay within Gemini's free tier; each case makes two Gemini calls (story + judge).

## Evaluate without Braintrust

```bash
GEMINI_API_KEY=your-key npm run eval:local
```

Options: `--model <name>`, `--only toddler-short,space`, `--delay 5000` (ms between calls). Writes one `.md` per story plus `results.json` to `evals/runs/<timestamp>/`.

Or call it directly:

```js
import { generateStory } from './lib/story.js';
const s = await generateStory({ name: 'Maya', age: 4, topic: 'a sleepy dragon', minutes: 5 });
```

`streamStory(input)` is the same thing as an async iterator of text chunks (what the web app uses).

Settings (env vars, or options to `generateStory`/`streamStory`):

| Env var | Option | Default | |
| --- | --- | --- | --- |
| `GEMINI_MODEL` | `model` | newest Flash-Lite your key can use | Which Gemini model to use. If unset, the app lists the models your key can call (once per server instance) and picks the newest stable Flash-Lite. |
| `GEMINI_THINKING_LEVEL` | `thinkingLevel` | model default for Flash-Lite, else `LOW` | `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`. Higher is slower; stories rarely benefit. |
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

Each story request logs a timing trace in the Vercel project's Logs tab (`story: done {...}` / `story: failed {...}`): when it was sent to Gemini, when Gemini replied, when thinking and the first story words arrived, the model version, token counts and any error. Evals record the same trace.

`/api/health` runs a few tiny Gemini requests with the deployed key and a speed comparison of model/thinking setups. Each visit uses a little of your Gemini quota.
