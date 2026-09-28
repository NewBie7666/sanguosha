import { describe, expect, it } from 'vitest';
import {
  buildEnginePolicySampleV1,
  normalizePolicyMode,
  toPolicyActionCandidatesV1,
  toPolicyStateV1,
} from '../../src/ai-match/policyProtocol';
import type { PlayerObservation, PublicLegalAction } from '../../src/ai-match/types';

function observation(): PlayerObservation {
  return {
    engine_id: 'wmzy/sanguosha',
    engine_revision: 'test',
    game_mode: '1v1',
    seat: 0,
    current_player: 0,
    phase: '出牌',
    round: 2,
    self: {
      seat: 0,
      name: 'A',
      character: '刘备',
      health: 3,
      max_health: 4,
      alive: true,
      hand_count: 1,
      equipment_slots: [],
      skills: ['仁德'],
      marks: [],
      hand: [{ name: '杀', suit: '♠', rank: '7', type: '基本牌' }],
    },
    players: [
      {
        seat: 0,
        name: 'A',
        character: '刘备',
        health: 3,
        max_health: 4,
        alive: true,
        hand_count: 1,
        equipment_slots: [],
        skills: ['仁德'],
        marks: [],
      },
      {
        seat: 1,
        name: 'B',
        character: '曹操',
        health: 2,
        max_health: 4,
        alive: true,
        hand_count: 2,
        equipment_slots: [],
        skills: [],
        marks: [],
      },
    ],
    pending: null,
    zones: { deck_count: 20, discard_count: 10 },
  };
}

function actions(): PublicLegalAction[] {
  return [
    {
      action_id: 'action_001',
      type: 'play',
      category: 'play',
      description: '使用【杀】 → B',
      target_seat: 1,
    },
    {
      action_id: 'action_002',
      type: 'end',
      category: 'skip',
      description: '结束出牌',
    },
  ];
}

describe('Sanguosha Policy Protocol v1', () => {
  it('normalizes engine mode and removes implementation-only identifiers', () => {
    expect(normalizePolicyMode('1v1')).toBe('duel_1v1');
    const state = toPolicyStateV1(observation());
    expect(state.mode).toBe('duel_1v1');
    expect(state.viewer_seat_id).toBe('0');
    expect(state.self?.hand?.[0]).toEqual({
      name: '杀',
      suit: '♠',
      rank: '7',
      type: '基本牌',
    });
    expect(JSON.stringify(state)).not.toContain('engine_revision');
  });

  it('converts concrete legal actions without leaking engine messages', () => {
    const candidates = toPolicyActionCandidatesV1(actions());
    expect(candidates[0]).toEqual({
      action_id: 'action_001',
      type: 'play',
      category: 'play',
      description: '使用【杀】 → B',
      target_seat_ids: ['1'],
    });
    expect(JSON.stringify(candidates)).not.toContain('message');
  });

  it('marks a valid accepted engine decision as training ready', () => {
    const sample = buildEnginePolicySampleV1({
      sample_id: 'engine-000001',
      observation: observation(),
      legal_actions: actions(),
      chosen_action_id: 'action_001',
      training_eligible: true,
    });
    expect(sample.training_ready).toBe(true);
    expect(sample.exclusion_reasons).toEqual([]);
  });

  it('refuses a chosen action that is not in the candidate set', () => {
    const sample = buildEnginePolicySampleV1({
      sample_id: 'engine-000002',
      observation: observation(),
      legal_actions: actions(),
      chosen_action_id: 'action_999',
      training_eligible: true,
    });
    expect(sample.training_ready).toBe(false);
    expect(sample.exclusion_reasons).toContain('chosen_action_not_in_legal_actions');
  });
});
