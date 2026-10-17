/**
 * Server entry point: run directly with Node 24 type stripping, no build step.
 *
 *   npm run start -- --host 0.0.0.0
 *   node src/server/main.ts --port 3848
 */

import { run } from './cli.ts';

process.exitCode = await run(process.argv.slice(2));
