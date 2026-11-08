// Smallest possible Braintrust eval: checks that the SDK, CLI and API key work.
//   npx braintrust eval --env-file .env.local evals/hello.eval.js
import { Eval } from 'braintrust';

Eval('goodnight', {
  experimentName: 'hello',
  data: () => [{ input: 'hi', expected: 'hi' }],
  task: (input) => input,
  scores: [({ output, expected }) => ({ name: 'exact_match', score: output === expected ? 1 : 0 })],
});
