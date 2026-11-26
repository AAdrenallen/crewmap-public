import { writeFileSync } from 'node:fs';
import sodiumImpl from 'libsodium-wrappers-sumo';
import { initSodium, type Sodium } from '@crewmap/p2p';
import { runScenario, type ScenarioResult } from '../sim/scenarios';
import { renderBenchmarkMarkdown } from '../sim/report';

await initSodium(sodiumImpl as unknown as Sodium);
const out = process.argv[2];
const results: ScenarioResult[] = [];
for (const name of ['drive-1h', 'idle-8h'] as const) {
  for (const mode of ['p2p', 'relay'] as const) {
    const r = await runScenario({ name, mode });
    results.push(r);
    process.stdout.write(`${name} ${mode}: ${JSON.stringify(r)}\n`);
  }
}
if (out) writeFileSync(out, renderBenchmarkMarkdown(results));
