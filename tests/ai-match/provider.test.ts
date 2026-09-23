import { describe, expect, it, vi } from 'vitest';
import type { ModelEndpointConfig, ProviderRequest } from '../../src/ai-match/types';
import { OpenAICompatibleProvider } from '../../src/ai-match/provider';

const endpoint: ModelEndpointConfig = {
  provider: 'openai_compatible',
  base_url: 'http://127.0.0.1:8001/v1',
  model: 'local-qwen',
  api_key: 'secret-token',
};

const input = {
  seat: 'a',
  observation: {
    engine_id: 'wmzy/sanguosha', engine_revision: 'test', game_mode: '1v1', seat: 0,
    current_player: 0, phase: '出牌', round: 1,
    self: { seat: 0, name: 'A', character: '刘备', health: 4, max_health: 4, alive: true, hand_count: 1,
      equipment_slots: [], skills: [], marks: [], hand: [{ name: '杀', suit: '♠', rank: '7', type: '基本牌' }] },
    players: [], pending: null, zones: { deck_count: 20, discard_count: 0 },
  },
  legal_actions: [{ action_id: 'action_001', type: 'skip', description: '跳过' }],
  recent_private_history: [],
} satisfies ProviderRequest;

function completion(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('OpenAI-compatible provider', () => {
  it('发送结构化动作 schema，返回原文和 token 使用量且请求体不包含 API key', async () => {
    const fetchImpl = vi.fn(async () => completion('{"action_id":"action_001"}')) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider(endpoint, fetchImpl);
    const result = await provider.chooseAction(input);
    expect(result.raw_text).toBe('{"action_id":"action_001"}');
    expect(result.usage?.total_tokens).toBe(13);
    expect(result.request_body['response_format']).toMatchObject({ type: 'json_schema' });
    expect(JSON.stringify(result.request_body)).not.toContain('secret-token');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8001/v1/chat/completions',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }) }),
    );
  });

  it('仅当 endpoint 明确不支持 json_schema 时降级为 JSON mode', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('unsupported response_format json_schema', { status: 400 }))
      .mockResolvedValueOnce(completion('{"action_id":"action_001"}')) as unknown as typeof fetch;
    const result = await new OpenAICompatibleProvider(endpoint, fetchImpl).chooseAction(input);
    expect(result.raw_text).toContain('action_001');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondCall = vi.mocked(fetchImpl).mock.calls[1];
    const body = JSON.parse(String(secondCall?.[1]?.body)) as Record<string, unknown>;
    expect(body['response_format']).toEqual({ type: 'json_object' });
  });
});
