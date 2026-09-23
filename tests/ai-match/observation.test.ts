import { describe, expect, it } from 'vitest';
import type { AiViewSnapshot } from '../../src/client/headless/types';
import { buildPlayerObservation } from '../../src/ai-match/observation';

function snapshot(viewer = 0): AiViewSnapshot {
  return {
    viewer,
    currentPlayerIndex: 0,
    phase: '出牌',
    turn: { round: 1 },
    players: [
      {
        index: 0,
        name: 'A',
        character: '刘备',
        health: 4,
        maxHealth: 4,
        alive: true,
        handCount: 1,
        hand: [{ id: 'visible-card-id', name: '杀', suit: '♠', rank: '7', type: '基本牌', color: '黑' }],
        equipment: {},
        skills: [],
        marks: [],
      },
      {
        index: 1,
        name: 'B',
        character: '曹操',
        health: 4,
        maxHealth: 4,
        alive: true,
        handCount: 2,
        equipment: {},
        skills: [],
        marks: [],
      },
    ],
    pending: null,
    zones: { deckCount: 20, discardPileCount: 0 },
    log: [{ time: 1, player: 1, text: '公开动作' }],
    cardMap: { hidden: 'SECRET_CARD_MAP_VALUE' },
  } as unknown as AiViewSnapshot;
}

describe('PlayerObservation 隐私边界', () => {
  it('改变对手隐藏手牌不会改变本玩家 observation', () => {
    const first = snapshot();
    const second = structuredClone(first) as AiViewSnapshot & { players: Array<Record<string, unknown>> };
    second.players[1]['hand'] = [
      { id: 'secret-2', name: '无懈可击', suit: '♥', rank: 'A', type: '锦囊牌', color: '红' },
      { id: 'secret-3', name: '桃', suit: '♦', rank: '3', type: '基本牌', color: '红' },
    ];
    const observationA = buildPlayerObservation(first, '1v1');
    const observationB = buildPlayerObservation(second, '1v1');
    expect(observationB).toEqual(observationA);
  });

  it('模型 observation 不含对手手牌、内部 cardMap、牌 ID 或原始事件日志', () => {
    const view = snapshot();
    const privateView = view as AiViewSnapshot & { players: Array<Record<string, unknown>>; cardMap: unknown };
    privateView.players[1]['hand'] = [{ id: 'opponent-secret-id', name: '无懈可击', suit: '♥', rank: 'A', type: '锦囊牌', color: '红' }];
    privateView.cardMap = { privateCard: 'SECRET_CARD_MAP_VALUE' };
    const serialized = JSON.stringify(buildPlayerObservation(view, '1v1'));
    expect(serialized).toContain('杀');
    expect(serialized).not.toContain('opponent-secret-id');
    expect(serialized).not.toContain('SECRET_CARD_MAP_VALUE');
    expect(serialized).not.toContain('visible-card-id');
    expect(serialized).not.toContain('公开动作');
  });

  it('当前座位的 observation 只包含该座位自己的手牌', () => {
    const view = snapshot(1) as AiViewSnapshot & { players: Array<Record<string, unknown>> };
    view.players[1]['hand'] = [{ id: 'b-card', name: '闪', suit: '♥', rank: '2', type: '基本牌', color: '红' }];
    const observation = buildPlayerObservation(view, '1v1');
    expect(observation.self.hand.map((card) => card.name)).toEqual(['闪']);
  });
});
