import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MatchConfig } from '../../src/ai-match/types';
import { runMatch } from '../../src/ai-match/matchRunner';

interface MockRequest {
  seat?: string;
  observation?: { seat?: number; players?: Array<Record<string, unknown>> };
  legal_actions?: Array<{ action_id: string; type: string; category?: string; description: string }>;
  recent_public_history?: Array<{ action?: string }>;
  relevant_rules?: Record<string, string>;
}

interface MockEndpoint {
  server: Server;
  url: string;
  requests: MockRequest[];
}

async function startMockEndpoint(): Promise<MockEndpoint> {
  const requests: MockRequest[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: Array<{ role: string; content: string }>;
    };
    const userMessage = (body.messages?.find((message) => message.role === 'user')?.content ?? '{}')
      .split('\n\n上一次选择无效：')[0] ?? '{}';
    const parsed = JSON.parse(userMessage) as MockRequest;
    requests.push(parsed);
    const actions = parsed.legal_actions ?? [];
    const chosen = actions.find((action) => /【杀】|决斗|南蛮入侵|万箭齐发|火攻/.test(action.description))
      ?? actions.find((action) => action.type !== 'end' && action.type !== 'skip')
      ?? actions[0];
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ action_id: chosen?.action_id ?? 'invalid' }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock endpoint did not bind an ephemeral TCP port');
  return { server, url: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe('match runner 完整闭环', () => {
  it('用两个独立 OpenAI-compatible mock endpoint 和 MCP 进程无人干预打完一局', async () => {
    const endpointA = await startMockEndpoint();
    const endpointB = await startMockEndpoint();
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'sanguosha-match-'));
    const gamePortServer = createServer();
    await new Promise<void>((resolve) => gamePortServer.listen(0, '127.0.0.1', resolve));
    const address = gamePortServer.address();
    if (!address || typeof address === 'string') throw new Error('game port reservation failed');
    const gamePort = address.port;
    await closeServer(gamePortServer);

    const config: MatchConfig = {
      server: {
        base_url: `http://127.0.0.1:${gamePort}`,
        auto_start: true,
        port: gamePort,
        startup_timeout_ms: 90_000,
      },
      game: { mode: '1v1', seed: 4201, timeout_sec: 5, char_pool: 'standard', hand_size: 4 },
      run: { games: 1, max_retries: 2, max_decisions: 1200, output_dir: outputDir, fallback: 'first' },
      players: {
        a: { provider: 'openai_compatible', base_url: endpointA.url, model: 'mock-a', api_key: 'secret-a', timeout_ms: 10_000 },
        b: { provider: 'openai_compatible', base_url: endpointB.url, model: 'mock-b', api_key: 'secret-b', timeout_ms: 10_000 },
      },
    };

    try {
      const summary = await runMatch(config, { cwd: process.cwd() });
      expect(summary['status']).toBe('completed');
      expect(summary['winner']).toBeTruthy();
      expect(summary['winner_player']).toMatch(/^(a|b)$/);
      expect(summary['loser_player']).toMatch(/^(a|b)$/);
      expect(summary['loser_player']).not.toBe(summary['winner_player']);
      expect(summary['decision_steps']).toBeGreaterThan(0);
      expect(endpointA.requests.length).toBeGreaterThan(0);
      expect(endpointB.requests.length).toBeGreaterThan(0);
      expect(endpointA.requests.every((request) => request.seat === 'a')).toBe(true);
      expect(endpointB.requests.every((request) => request.seat === 'b')).toBe(true);
      const allRequests = [...endpointA.requests, ...endpointB.requests];
      expect(allRequests.every((request) => request.relevant_rules && typeof request.relevant_rules === 'object')).toBe(true);
      expect(allRequests.some((request) => (request.recent_public_history?.length ?? 0) > 0)).toBe(true);
      for (const request of allRequests) {
        expect(request.legal_actions?.every((action) => !('message' in action))).toBe(true);
        expect(JSON.stringify(request)).not.toContain('cardMap');
        expect(JSON.stringify(request)).not.toContain('visible-card-id');
        expect(request.observation?.players?.every((player) => !('hand' in player))).toBe(true);
      }

      const runDirectory = String(summary['run_dir']);
      const savedConfig = await readFile(path.join(runDirectory, 'config.json'), 'utf8');
      expect(savedConfig).not.toContain('secret-a');
      expect(savedConfig).not.toContain('secret-b');
      const events = (await readFile(path.join(runDirectory, 'game.jsonl'), 'utf8'))
        .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toHaveLength(Number(summary['decision_steps']));
      expect(events.at(-1)?.['game_result_after_action']).toBeTruthy();
      expect(summary['legal_action_coverage']).toEqual(expect.objectContaining({
        total_templates: expect.any(Number),
        supported_templates: expect.any(Number),
        unsupported_templates: expect.any(Number),
        coverage_ratio: expect.any(Number),
      }));
      expect(Number(summary['training_eligible_steps'])).toBeGreaterThan(0);
      expect(summary['invalid_model_outputs']).toBe(0);
      expect(summary['model_parse_errors']).toBe(0);
      expect(summary['model_invalid_action_ids']).toBe(0);
      expect(summary['model_request_errors']).toBe(0);
      expect(summary['stale_windows']).toEqual(expect.any(Number));
      expect(summary['engine_rejection_reasons']).toEqual(expect.any(Object));
      expect(events.every((event) => event['legal_action_coverage'])).toBe(true);
      expect(events.every((event) => Array.isArray(event['engine_rejection_reasons']))).toBe(true);
      expect(events.every((event) => Array.isArray(event['model_error_kinds']))).toBe(true);
      expect(events.every((event) => {
        const timing = event['timing_ms'] as Record<string, unknown> | undefined;
        return timing
          && typeof timing['wait_for_decision_ms'] === 'number'
          && typeof timing['snapshot_ms'] === 'number'
          && typeof timing['rule_context_ms'] === 'number'
          && typeof timing['model_request_ms'] === 'number'
          && typeof timing['action_submit_ms'] === 'number'
          && typeof timing['engine_settlement_ms'] === 'number';
      })).toBe(true);
      expect(events.every((event) => {
        const waits = event['wait_diagnostics'] as Record<string, unknown> | undefined;
        return waits
          && typeof waits['silent_pending_wait_count'] === 'number'
          && typeof waits['silent_pending_wait_ms'] === 'number'
          && typeof waits['other_wait_timeout_count'] === 'number'
          && typeof waits['other_wait_timeout_ms'] === 'number';
      })).toBe(true);
      expect(summary['performance_ms']).toEqual(expect.objectContaining({
        total: expect.objectContaining({
          wait_for_decision_ms: expect.any(Number),
          snapshot_ms: expect.any(Number),
          rule_context_ms: expect.any(Number),
          model_request_ms: expect.any(Number),
          action_submit_ms: expect.any(Number),
          engine_settlement_ms: expect.any(Number),
        }),
        average_per_decision: expect.any(Object),
      }));
      expect(summary['wait_diagnostics']).toEqual(expect.objectContaining({
        silent_pending_wait_count: expect.any(Number),
        silent_pending_wait_ms: expect.any(Number),
        other_wait_timeout_count: expect.any(Number),
        other_wait_timeout_ms: expect.any(Number),
      }));
      const summaryJson = await readFile(path.join(runDirectory, 'summary.json'), 'utf8');
      const summaryMd = await readFile(path.join(runDirectory, 'summary.md'), 'utf8');
      expect(summaryJson).toContain('"performance_ms"');
      expect(summaryMd).toContain('## 性能诊断');
      expect(summaryMd).toContain('silent pending');
      expect((await readdir(runDirectory)).sort()).toEqual(['config.json', 'game.jsonl', 'summary.json', 'summary.md']);
    } finally {
      await Promise.all([closeServer(endpointA.server), closeServer(endpointB.server)]);
      await rm(outputDir, { recursive: true, force: true });
    }
  }, 480_000);
});
