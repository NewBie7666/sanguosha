import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import type { MatchConfig, ModelEndpointConfig } from './types';

export interface CliOverrides {
  configPath: string;
  games?: number;
  seed?: number;
  playerA?: string;
  playerB?: string;
  headless: boolean;
  help: boolean;
}

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function expandEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
      return process.env[name] ?? fallback ?? '';
    });
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expandEnv(child)]));
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function numberValue(value: unknown, fallback: number, name: string, min = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be a finite number >= ${min}`);
  }
  return value;
}

function endpointFrom(value: unknown, name: string): ModelEndpointConfig {
  if (!isRecord(value)) throw new Error(`${name} must reference a profile or endpoint mapping`);
  const baseUrl = requiredString(value['base_url'], `${name}.base_url`).replace(/\/+$/, '');
  const model = requiredString(value['model'], `${name}.model`);
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(baseUrl);
  } catch {
    throw new Error(`${name}.base_url must be an absolute URL`);
  }
  if (endpointUrl.username || endpointUrl.password) {
    throw new Error(`${name}.base_url must not embed credentials; use api_key instead`);
  }
  const apiKey = typeof value['api_key'] === 'string' && value['api_key'] ? value['api_key'] : 'dummy';
  const provider = value['provider'] ?? 'openai_compatible';
  if (provider !== 'openai_compatible') throw new Error(`${name}.provider must be openai_compatible`);
  return {
    provider,
    base_url: baseUrl,
    model,
    api_key: apiKey,
    ...(typeof value['temperature'] === 'number' ? { temperature: value['temperature'] } : {}),
    ...(typeof value['max_tokens'] === 'number' ? { max_tokens: value['max_tokens'] } : {}),
    ...(typeof value['timeout_ms'] === 'number' ? { timeout_ms: value['timeout_ms'] } : {}),
  };
}

function resolvePlayer(
  value: unknown,
  override: string | undefined,
  profiles: AnyRecord,
  name: 'players.a' | 'players.b',
): ModelEndpointConfig {
  const selected = override ?? value;
  if (typeof selected === 'string') {
    const profile = profiles[selected];
    if (!profile) throw new Error(`${name} references unknown profile "${selected}"`);
    return endpointFrom(profile, `profiles.${selected}`);
  }
  return endpointFrom(selected, name);
}

export function parseCliArgs(argv: string[]): CliOverrides {
  const result: CliOverrides = { configPath: 'config/match.example.yaml', headless: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--headless') result.headless = true;
    else if (['--config', '--games', '--seed', '--player-a', '--player-b'].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--config') result.configPath = value;
      else if (arg === '--games') result.games = Number(value);
      else if (arg === '--seed') result.seed = Number(value);
      else if (arg === '--player-a') result.playerA = value;
      else if (arg === '--player-b') result.playerB = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (result.games !== undefined && (!Number.isInteger(result.games) || result.games !== 1)) {
    throw new Error('Phase 1 supports --games 1 only');
  }
  if (result.seed !== undefined && (!Number.isSafeInteger(result.seed) || result.seed < 0)) {
    throw new Error('--seed must be a non-negative safe integer');
  }
  return result;
}

export async function loadMatchConfig(overrides: CliOverrides, cwd = process.cwd()): Promise<MatchConfig> {
  const configPath = path.resolve(cwd, overrides.configPath);
  const parsed = expandEnv(parseYaml(await readFile(configPath, 'utf8')));
  if (!isRecord(parsed)) throw new Error('match config must contain a YAML mapping');
  const server = isRecord(parsed['server']) ? parsed['server'] : {};
  const game = isRecord(parsed['game']) ? parsed['game'] : {};
  const run = isRecord(parsed['run']) ? parsed['run'] : {};
  const players = isRecord(parsed['players']) ? parsed['players'] : {};
  const profiles = isRecord(parsed['profiles']) ? parsed['profiles'] : {};

  const mode = game['mode'] ?? '1v1';
  if (mode !== '1v1' && mode !== '身份局') throw new Error('game.mode must be 1v1 or 身份局');
  const charPool = game['char_pool'] ?? 'standard';
  if (charPool !== 'standard' && charPool !== 'extended' && charPool !== 'all') {
    throw new Error('game.char_pool must be standard, extended, or all');
  }
  const fallback = run['fallback'] ?? 'first';
  if (fallback !== 'first') throw new Error('Phase 1 supports run.fallback: first only');
  const games = numberValue(run['games'], 1, 'run.games', 1);
  if (games !== 1) throw new Error('Phase 1 supports run.games: 1 only');
  const baseUrl = typeof server['base_url'] === 'string' ? server['base_url'] : 'http://127.0.0.1:3930';
  const portFromUrl = Number(new URL(baseUrl).port || (baseUrl.startsWith('https:') ? 443 : 80));

  return {
    server: {
      base_url: baseUrl.replace(/\/+$/, ''),
      auto_start: server['auto_start'] !== false,
      port: Math.floor(numberValue(server['port'], portFromUrl, 'server.port', 1)),
      startup_timeout_ms: Math.floor(numberValue(server['startup_timeout_ms'], 60_000, 'server.startup_timeout_ms', 1000)),
    },
    game: {
      mode,
      seed: overrides.seed ?? Math.floor(numberValue(game['seed'], 1, 'game.seed', 0)),
      timeout_sec: Math.floor(numberValue(game['timeout_sec'], 15, 'game.timeout_sec', 1)),
      char_pool: charPool,
      hand_size: Math.floor(numberValue(game['hand_size'], 4, 'game.hand_size', 0)),
    },
    run: {
      games: 1,
      max_retries: Math.floor(numberValue(run['max_retries'], 2, 'run.max_retries', 0)),
      max_decisions: Math.floor(numberValue(run['max_decisions'], 2000, 'run.max_decisions', 1)),
      output_dir: path.resolve(cwd, typeof run['output_dir'] === 'string' ? run['output_dir'] : 'runs'),
      fallback,
    },
    players: {
      a: resolvePlayer(players['a'], overrides.playerA, profiles, 'players.a'),
      b: resolvePlayer(players['b'], overrides.playerB, profiles, 'players.b'),
    },
  };
}

export function redactConfig(config: MatchConfig): Record<string, unknown> {
  const redact = (endpoint: ModelEndpointConfig) => ({
    ...endpoint,
    api_key: endpoint.api_key ? '[REDACTED]' : '',
  });
  return {
    ...config,
    players: { a: redact(config.players.a), b: redact(config.players.b) },
    internal_state_policy: 'not_sent_to_models; engine-internal state is not copied into experiment logs',
  };
}
