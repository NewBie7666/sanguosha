import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMatchConfig, parseCliArgs, redactConfig } from '../../src/ai-match/config';

describe('match 配置', () => {
  it('读取 A/B 独立 endpoint，并在落盘配置中脱敏 API key', async () => {
    const originalA = process.env['AI_A_API_KEY'];
    const originalB = process.env['AI_B_API_KEY'];
    process.env['AI_A_API_KEY'] = 'secret-a';
    process.env['AI_B_API_KEY'] = 'secret-b';
    try {
      const args = parseCliArgs(['--config', 'config/match.example.yaml', '--games', '1', '--seed', '42', '--headless']);
      const config = await loadMatchConfig(args, process.cwd());
      expect(config.players.a.base_url).toContain(':8001/v1');
      expect(config.players.b.base_url).toContain(':8002/v1');
      expect(config.game.seed).toBe(42);
      const redacted = JSON.stringify(redactConfig(config));
      expect(redacted).not.toContain('secret-a');
      expect(redacted).not.toContain('secret-b');
    } finally {
      if (originalA === undefined) delete process.env['AI_A_API_KEY'];
      else process.env['AI_A_API_KEY'] = originalA;
      if (originalB === undefined) delete process.env['AI_B_API_KEY'];
      else process.env['AI_B_API_KEY'] = originalB;
    }
  });

  it('拒绝命令行批量对局', () => {
    expect(() => parseCliArgs(['--games', '2'])).toThrow(/supports --games 1/);
  });

  it('拒绝 YAML 配置要求运行多局', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sanguosha-config-'));
    const file = path.join(directory, 'match.yaml');
    const valid = await readFile(path.join(process.cwd(), 'config/match.example.yaml'), 'utf8');
    await writeFile(file, valid.replace('  games: 1', '  games: 2'), 'utf8');
    try {
      await expect(loadMatchConfig(parseCliArgs(['--config', file]), directory)).rejects.toThrow(/run.games: 1 only/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
