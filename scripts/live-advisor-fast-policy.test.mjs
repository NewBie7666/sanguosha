import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContext } from './live-advisor-core.mjs';
import { LiveAdvisor } from './live-advisor.mjs';
import { evaluateFastPolicy } from './live-advisor-fast-policy.mjs';

function event(prompt, hand, {
  frameId = 42,
  selfHealth = 2,
  selfRole = '主公',
  selfRoleConfidence = 0.99,
  left = { role: '反贼', role_confidence: 0.99, health: 2, visible_text: '张辽' },
} = {}) {
  return {
    plugin: 'sanguosha',
    frame_id: frameId,
    timestamp: new Date(1_004_200).toISOString(),
    state: { data: {
      decision: { prompt },
      hand_cards: hand,
      players: {
        self: {
          role: selfRole,
          role_confidence: selfRoleConfidence,
          health: selfHealth,
          visible_text: '曹操',
        },
        left,
      },
    } },
  };
}

function context(prompt, hand, options) {
  return buildContext(event(prompt, hand, options));
}

test('fast discard policy uses only high-confidence visible cards', () => {
  const result = evaluateFastPolicy(context('弃牌阶段，选1张手牌', [
    { name: '杀', confidence: 0.99 },
    { name: '桃', confidence: 0.98 },
  ]));
  assert.equal(result.status, 'ready');
  assert.match(result.advice, /弃第1张【杀】/);
  assert.equal(result.source, 'fast_policy');
  assert.ok(result.policy_ms < 100);
});

test('fast discard policy abstains for unreadable or unscored cards', () => {
  const lowConfidence = evaluateFastPolicy(context('弃牌阶段，选1张手牌', [
    { name: '杀', confidence: 0.79 },
    { name: '桃', confidence: 0.99 },
  ]));
  assert.equal(lowConfidence.status, 'abstain');

  const unknownCard = evaluateFastPolicy(context('弃牌阶段，选1张手牌', [
    { name: '神秘牌', confidence: 0.99 },
    { name: '桃', confidence: 0.99 },
  ]));
  assert.equal(unknownCard.status, 'abstain');
  assert.match(unknownCard.reason, /未收录/);
});

test('fast flash policy only recommends at one health with a readable flash', () => {
  const lowHealth = evaluateFastPolicy(context('请出闪', [
    { name: '闪', confidence: 0.97 },
  ], { selfHealth: 1 }));
  assert.equal(lowHealth.status, 'ready');
  assert.match(lowHealth.advice, /打出第1张【闪】/);
  assert.ok(lowHealth.policy_ms < 100);

  const safeHealth = evaluateFastPolicy(context('请出闪', [
    { name: '闪', confidence: 0.97 },
  ], { selfHealth: 2 }));
  assert.equal(safeHealth.status, 'abstain');
});

test('fast rescue policy requires a reliable self or ally relation', () => {
  const ally = evaluateFastPolicy(context('张辽生命危急，需要1个桃。', [
    { name: '桃', confidence: 0.98 },
  ], {
    left: { role: '忠臣', role_confidence: 0.99, health: 0, visible_text: '张辽' },
  }));
  assert.equal(ally.status, 'ready');
  assert.match(ally.advice, /使用第1张【桃】/);

  const unknownRole = evaluateFastPolicy(context('张辽生命危急，需要1个桃。', [
    { name: '桃', confidence: 0.98 },
  ], {
    left: { role: '忠臣', role_confidence: 0.4, health: 0, visible_text: '张辽' },
  }));
  assert.equal(unknownRole.status, 'abstain');
  assert.match(unknownRole.reason, /核对身份/);

  const enemy = evaluateFastPolicy(context('张辽生命危急，需要1个桃。', [
    { name: '桃', confidence: 0.98 },
  ], {
    left: { role: '反贼', role_confidence: 0.99, health: 0, visible_text: '张辽' },
  }));
  assert.equal(enemy.status, 'abstain');

  const self = evaluateFastPolicy(context('你生命危急，需要1个桃。', [
    { name: '桃', confidence: 0.98 },
  ], { selfHealth: 0 }));
  assert.equal(self.status, 'ready');
});

test('disconnected model is not on the fast path for an ambiguous decision', async () => {
  let modelCalls = 0;
  const advisor = new LiveAdvisor({
    now: () => 1_004_200,
    advise: async () => {
      modelCalls += 1;
      throw new Error('本机模型未连接');
    },
  });
  advisor.ingest(event('弃牌阶段，选1张手牌', [
    { name: '神秘牌', confidence: 0.99 },
    { name: '桃', confidence: 0.99 },
  ]));
  await Promise.resolve();
  assert.equal(modelCalls, 1);
  assert.equal(advisor.snapshot().status, 'error');
  assert.equal(advisor.snapshot().source, undefined);
});

test('safe discard advice bypasses the model when it is disconnected', () => {
  let modelCalls = 0;
  const advisor = new LiveAdvisor({
    now: () => 1_004_200,
    advise: async () => {
      modelCalls += 1;
      throw new Error('本机模型未连接');
    },
  });
  advisor.ingest(event('弃牌阶段，选1张手牌', [
    { name: '杀', confidence: 0.99 },
    { name: '桃', confidence: 0.99 },
  ]));
  assert.equal(modelCalls, 0);
  assert.equal(advisor.snapshot().status, 'ready');
  assert.ok(advisor.snapshot().policy_ms < 100);
});

test('a fast result is replaced when the visible decision becomes stale', async () => {
  const pending = [];
  const advisor = new LiveAdvisor({
    now: () => 1_004_200,
    advise: (_context, { signal }) => new Promise((resolve) => pending.push({ resolve, signal })),
  });
  advisor.ingest(event('弃牌阶段，选1张手牌', [
    { name: '杀', confidence: 0.99 },
    { name: '桃', confidence: 0.99 },
  ]));
  assert.equal(advisor.snapshot().source, 'fast_policy');

  advisor.ingest(event('出牌阶段，请选择1张卡牌', [
    { name: '杀', confidence: 0.99 },
  ], { frameId: 43 }));
  assert.equal(pending.length, 1);
  assert.equal(advisor.snapshot().status, 'thinking');
  pending[0].resolve({ status: 'ready', advice: '当前模型建议' });
  await Promise.resolve();
  assert.equal(advisor.snapshot().advice, '当前模型建议');
  assert.equal(advisor.snapshot().source, undefined);
});
