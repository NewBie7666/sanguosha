import { describe, expect, it } from 'vitest';
import type { AiViewSnapshot, AvailableAction } from '../../src/client/headless/types';
import {
  buildLegalActions,
  chooseDeterministicFallback,
  parseActionId,
  resolveActionId,
  toPublicLegalActions,
} from '../../src/ai-match/legalActions';

function snapshot(): AiViewSnapshot {
  return {
    viewer: 0,
    currentPlayerIndex: 0,
    phase: '出牌',
    turn: { round: 1 },
    players: [
      {
        index: 0, name: 'A', character: '刘备', health: 4, maxHealth: 4, alive: true, handCount: 1,
        hand: [{ id: 'slash-1', name: '杀', suit: '♠', rank: '7', type: '基本牌', color: '黑' }],
        equipment: {}, skills: [], marks: [],
      },
      { index: 1, name: 'B', character: '曹操', health: 4, maxHealth: 4, alive: true, handCount: 2, equipment: {}, skills: [], marks: [] },
    ],
    pending: null,
    zones: { deckCount: 20, discardPileCount: 0 },
    log: [],
  };
}

function available(actionType: string, params: Record<string, unknown>, extra: Partial<AvailableAction> = {}): AvailableAction {
  return {
    description: actionType,
    message: { skillId: '杀', actionType, ownerId: 0, params, baseSeq: 4 },
    validTargets: [],
    category: 'play',
    ...extra,
  } as AvailableAction;
}

describe('合法动作适配', () => {
  it('把引擎的目标模板展开为具体合法目标，并隐藏底层消息', () => {
    const actions = buildLegalActions([
      available('use', { cardId: 'slash-1', targets: [] }, { validTargets: [1] }),
    ], snapshot());
    expect(actions).toHaveLength(1);
    expect(actions[0]?.target_seat).toBe(1);
    expect(actions[0]?.message.params['targets']).toEqual([1]);
    expect(toPublicLegalActions(actions)[0]).not.toHaveProperty('message');
  });

  it('不暴露没有安全具体化的复合动作模板', () => {
    const view = snapshot();
    const card = view.players[0]?.hand?.[0];
    if (!card) throw new Error('fixture card missing');
    card.name = '借刀杀人';
    card.type = '锦囊牌';
    const actions = buildLegalActions([
      available('use', { cardId: 'slash-1', targets: [] }, {
        description: '借刀杀人', validTargets: [1],
        message: { skillId: '借刀杀人', actionType: 'use', ownerId: 0, params: { cardId: 'slash-1', targets: [] }, baseSeq: 4 },
      }),
    ], view);
    expect(actions).toEqual([]);
  });

  it('只接受具有 action_id 的 JSON，并由当前动作表验证其存在', () => {
    expect(parseActionId('{"action_id":"action_001"}')).toBe('action_001');
    expect(() => parseActionId('选择 action_001')).toThrow();
    expect(() => parseActionId('{"action_id":4}')).toThrow();
    const actions = buildLegalActions([
      available('skip', {}, { category: 'skip' }),
    ], snapshot());
    expect(actions.some((action) => action.action_id === 'action_999')).toBe(false);
    expect(() => resolveActionId('action_999', actions)).toThrow(/not in current legal_actions/);
    expect(resolveActionId('action_001', actions)).toBe(actions[0]);
  });

  it('确定性 fallback 优先选择跳过/结束等合法动作', () => {
    const actions = buildLegalActions([
      available('use', { cardId: 'slash-1' }),
      available('skip', {}, { category: 'skip' }),
    ], snapshot());
    expect(chooseDeterministicFallback(actions)?.type).toBe('skip');
    expect(chooseDeterministicFallback([])).toBeNull();
  });

  it('仅对自己可跳过的非强制阻塞窗口提供保守 pass', () => {
    const view = snapshot();
    view.pending = {
      target: 0,
      isBlocking: true,
      mandatory: false,
      promptTitle: '等待出闪',
      requestType: '',
    };
    const pass = buildLegalActions([], view);
    expect(pass).toHaveLength(1);
    expect(pass[0]?.type).toBe('skip');
    view.pending.mandatory = true;
    expect(buildLegalActions([], view)).toEqual([]);
  });
});
