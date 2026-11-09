// Braintrust eval for the story generator.
//   npm run eval:bt               (logs an experiment to Braintrust)
//   npm run eval:bt -- --no-send-logs   (run locally only)
// Settings via env: EVAL_MODEL (default: same model the app picks), JUDGE_MODEL
// (default: newest non-Lite Flash),
// EVAL_TRIALS (runs per case, default 1),
// EVAL_PROMPT (prompt version from PROMPT_ADDITIONS in lib/story.js, default v1),
// EVAL_EXPERIMENT (experiment name in Braintrust, default: generated).
import { Eval } from 'braintrust';
import { generateStory } from '../lib/story.js';
import { lengthWithin, wordLevel, usesName, cleanFormat, makeStoryJudge, withRetry } from './scorers.js';
// The Braintrust CLI bundles this file, inlining the JSON.
import cases from './cases.json';

const promptVersion = process.env.EVAL_PROMPT || 'v1';

Eval('goodnight', {
  experimentName: process.env.EVAL_EXPERIMENT || undefined,
  data: () => cases.map(({ id, ...input }) => ({ input, metadata: { case: id } })),

  task: async (input, hooks) => {
    const story = await withRetry(() => generateStory(input, { model: process.env.EVAL_MODEL || undefined, promptVersion }));
    Object.assign(hooks.metadata, {
      model: story.model,
      promptVersion,
      modelVersion: story.trace.modelVersion,
      wordCount: story.wordCount,
      targetWords: story.targetWords,
      latencyMs: story.latencyMs,
      firstTextMs: story.trace.firstTextMs,
      thoughtsTokens: story.trace.thoughtsTokens,
      outputTokens: story.trace.outputTokens,
    });
    return { title: story.title, body: story.body };
  },

  scores: [lengthWithin, wordLevel, makeStoryJudge(), cleanFormat, usesName],

  // Free tier: one case at a time keeps us under the per-minute request limit.
  maxConcurrency: 1,
  trialCount: Number(process.env.EVAL_TRIALS || 1),
  metadata: {
    model: process.env.EVAL_MODEL || 'auto (newest Flash-Lite)',
    promptVersion,
    judgeModel: process.env.JUDGE_MODEL || 'auto (newest non-Lite Flash)',
  },
});
