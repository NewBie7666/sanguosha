import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { buildEnginePolicySampleV1 } from '../src/ai-match/policyProtocol';
import type { PlayerObservation, PublicLegalAction } from '../src/ai-match/types';

interface DecisionEvent {
  step?: number;
  player?: string;
  player_observation?: PlayerObservation;
  legal_actions?: PublicLegalAction[];
  parsed_action?: { action_id?: string; description?: string };
  training_eligible?: boolean;
  [key: string]: unknown;
}

function usage(): never {
  throw new Error(
    'usage: pnpm policy:export <game.jsonl> [policy-v1.jsonl] [--include-unready]',
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const includeUnready = args.includes('--include-unready');
  const positional = args.filter((arg) => arg !== '--include-unready');
  const inputPath = positional[0] ?? usage();
  const outputPath = positional[1] ?? path.join(path.dirname(inputPath), 'policy-v1.jsonl');

  await mkdir(path.dirname(outputPath), { recursive: true });
  const output = await open(outputPath, 'w');
  let total = 0;
  let written = 0;
  let ready = 0;

  try {
    const lines = readline.createInterface({
      input: createReadStream(inputPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      total++;
      const event = JSON.parse(line) as DecisionEvent;
      if (!event.player_observation || !Array.isArray(event.legal_actions)) continue;
      const sample = buildEnginePolicySampleV1({
        sample_id: `engine-${String(event.step ?? total).padStart(6, '0')}`,
        observation: event.player_observation,
        legal_actions: event.legal_actions,
        chosen_action_id: event.parsed_action?.action_id ?? null,
        training_eligible: event.training_eligible === true,
        metadata: {
          step: event.step ?? null,
          player: event.player ?? null,
          parsed_action_description: event.parsed_action?.description ?? null,
        },
      });
      if (sample.training_ready) ready++;
      if (sample.training_ready || includeUnready) {
        await output.write(`${JSON.stringify(sample)}\n`);
        written++;
      }
    }
  } finally {
    await output.close();
  }

  console.log(
    `input=${inputPath} total=${total} ready=${ready} written=${written} output=${outputPath}`,
  );
}

await main();
