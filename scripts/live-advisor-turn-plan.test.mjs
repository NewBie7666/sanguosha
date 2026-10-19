import assert from 'node:assert/strict';
import test from 'node:test';

import { validateTurnPlan } from './live-advisor-turn-plan.mjs';

function context({ unknown = false, extra = [] } = {}) {
  const hand = [
    { index: 1, name: '杀', confidence: 0.99 },
    { index: 2, name: '闪', confidence: 0.99 },
    { index: 3, name: '桃', confidence: 0.99 },
  ];
  const rules = { 杀: '对目标出杀', 闪: '抵消杀', 桃: '回复体力' };
  if (unknown) {
    hand.push({ index: 4, name: '未识别牌', confidence: 0.55 });
  }
  return {
    kind: 'play',
    unreadable_card_count: unknown ? 1 : 0,
    hand,
    rules,
    candidates: [
      { id: 'consider-1-left', label: '第1张【杀】对左侧出杀', card_name: '杀', target: 'left' },
      { id: 'consider-1-right', label: '第1张【杀】对右侧出杀', card_name: '杀', target: 'right' },
      { id: 'consider-2', label: '保留第2张【闪】', card_name: '闪' },
      { id: 'consider-3', label: '保留第3张【桃】', card_name: '桃' },
      { id: 'end', label: '结束出牌' },
      ...extra,
    ],
  };
}

function parsed(plan, reserve = []) {
  return {
    choice_id: plan[0],
    reason: '先按当前可见手牌安排顺序',
    plan,
    reserve,
  };
}

test('returns a complete ordered plan and preserves flash and peach', () => {
  const result = validateTurnPlan(
    context(),
    parsed(['consider-1-left', 'end'], [2, 3]),
  );

  assert.deepEqual(result.turn_plan.map((candidate) => candidate.id), ['consider-1-left', 'end']);
  assert.deepEqual(result.reserve_cards.map((card) => card.index), [2, 3]);
  assert.equal(result.turn_plan_text, '1. 第1张【杀】对左侧出杀\n2. 结束出牌');
  assert.equal(result.reserve_text, '第2张【闪】、第3张【桃】');
  assert.match(result.planning_note, /后续步骤都是有条件的/);
  assert.match(result.planning_note, /手牌、玩家状态或公共历史变化时必须重新规划/);
});

test('rejects using one physical card for two different targets', () => {
  assert.throws(
    () => validateTurnPlan(
      context(),
      parsed(['consider-1-left', 'consider-1-right', 'end'], [2, 3]),
    ),
    /第1张手牌不能用于多个计划步骤/,
  );
});

test('does not allow an unreadable card into a plan or disguised reserve', () => {
  const unknownContext = context({
    unknown: true,
    extra: [{ id: 'consider-4-left', label: '用第4张牌对左侧', card_name: '未识别牌' }],
  });
  assert.throws(
    () => validateTurnPlan(unknownContext, parsed(['consider-4-left', 'end'], [2, 3, 1])),
    /未识别手牌不能进入计划/,
  );

  assert.throws(
    () => validateTurnPlan(unknownContext, parsed(['consider-1-left', 'end'], [2, 3, 4])),
    /未识别手牌不能伪装为保留牌/,
  );
});

test('requires every reliably recognized card to be covered exactly once', () => {
  assert.throws(
    () => validateTurnPlan(context(), parsed(['consider-1-left', 'end'], [2])),
    /已识别的第3张手牌没有安排计划或保留/,
  );
});

test('conservatively rejects more than one Slash in a plan', () => {
  const current = context({
    extra: [{ id: 'consider-4', label: '第二张杀', card_name: '杀', card_index: 4 }],
  });
  current.hand.push({ index: 4, name: '杀', confidence: 0.99 });
  assert.throws(
    () => validateTurnPlan(current, parsed(['consider-1-left', 'consider-4', 'end'], [2, 3])),
    /计划最多安排一张杀/,
  );
});

test('stops after drawing and rejects blind follow-up or end steps', () => {
  const current = context({
    extra: [
      { id: 'consider-4', label: '使用无中生有', card_name: '无中生有', card_index: 4 },
    ],
  });
  current.rules['无中生有'] = '摸两张牌';
  current.hand.push({ index: 4, name: '无中生有', confidence: 0.99 });
  assert.throws(
    () => validateTurnPlan(current, parsed(['consider-4', 'end'], [1, 2, 3])),
    /抽牌后必须停止计划/,
  );
  assert.throws(
    () => validateTurnPlan(current, parsed(['consider-4', 'consider-1-left'], [2, 3])),
    /抽牌后必须停止计划/,
  );

  const result = validateTurnPlan(current, parsed(['consider-4'], [1, 2, 3]));
  assert.match(result.planning_note, /抽牌完成后必须重新规划/);
});

test('requires end to terminate the plan', () => {
  assert.throws(
    () => validateTurnPlan(context(), parsed(['end', 'consider-1-left'], [2, 3])),
    /end 只能作为计划最后一步/,
  );
});

test('rejects invalid IDs, indexes, duplicates, and non-play contexts', () => {
  assert.throws(
    () => validateTurnPlan(context(), parsed(['consider-9'], [1, 2, 3])),
    /候选 consider-9 不存在/,
  );
  assert.throws(
    () => validateTurnPlan(context(), parsed(['consider-1-left', 'end'], [2, 2, 3])),
    /reserve 重复使用第2张手牌/,
  );
  assert.throws(
    () => validateTurnPlan(context(), parsed(['consider-1-left', 'end'], ['2', 3])),
    /reserve 中的手牌索引必须是整数/,
  );
  assert.throws(
    () => validateTurnPlan({ ...context(), kind: 'discard' }, parsed(['consider-1-left'], [2, 3])),
    /仅适用于出牌阶段/,
  );
});

test('requires choice_id to identify the first plan step', () => {
  const value = parsed(['consider-1-left', 'end'], [2, 3]);
  value.choice_id = 'end';
  assert.throws(() => validateTurnPlan(context(), value), /choice_id 必须等于计划的第一步/);
});

