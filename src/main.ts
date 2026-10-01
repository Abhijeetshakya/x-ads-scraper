import { Actor } from 'apify';
import { runPipeline } from './pipeline.js';
import { outputHooks } from './output-pipeline.js';
import type { Input } from './types.js';

await Actor.main(async () => {
  const input = await Actor.getInput<Input>();
  await runPipeline(input ?? { advertisers: ['Nike'] }, outputHooks);
});
