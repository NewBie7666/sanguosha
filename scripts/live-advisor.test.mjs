import assert from 'node:assert/strict';
import test from 'node:test';

import { LiveAdvisor } from './live-advisor.mjs';

function event(frameId, prompt = '出牌阶段，请选择1张卡牌', hand = '杀') {
  return {
    frame_id: frameId,
    timestamp: new Date(1_000_000 + frameId * 100).toISOString(),
    event: 'scene_changed',
    state: { data: {
      decision: { prompt },
      hand_cards: [{ name: hand, confidence: 0.99 }],
      players: {
        self: { role: '主公', role_confidence: 0.99, health: 2 },
        left: { role: '反贼', role_confidence: 0.99, health: 1 },
      },
    } },
  };
}

test('skips the model when the visible decision is not actionable', () => {
  let calls = 0;
  const advisor = new LiveAdvisor({ now: () => 1_000_100, advise: async () => { calls++; } });
  advisor.ingest(event(1, '请等待其他玩家'));
  assert.equal(advisor.snapshot().status, 'waiting');
  assert.equal(calls, 0);
});

test('ignores an older model answer after the visible hand changes', async () => {
  const pending = [];
  const advisor = new LiveAdvisor({
    now: () => 1_000_200,
    advise: (_context, { signal }) => new Promise((resolve) => pending.push({ resolve, signal })),
  });
  advisor.ingest(event(1));
  advisor.ingest(event(2, '出牌阶段，请选择1张卡牌', '桃'));
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve({ status: 'ready', advice: '过期建议' });
  await Promise.resolve();
  assert.equal(advisor.snapshot().status, 'thinking');
  pending[1].resolve({ status: 'ready', advice: '当前建议' });
  await Promise.resolve();
  assert.equal(advisor.snapshot().advice, '当前建议');
});

test('hides a suggestion after the source event becomes stale', async () => {
  let time = 1_000_100;
  const advisor = new LiveAdvisor({
    now: () => time,
    advise: async () => ({ status: 'ready', advice: '出杀' }),
  });
  advisor.ingest(event(1));
  await Promise.resolve();
  assert.equal(advisor.snapshot().status, 'ready');
  time += 5_000;
  assert.equal(advisor.snapshot().status, 'stale');
  assert.equal(advisor.snapshot().advice, undefined);
});

test('keeps one model request when OCR only changes prompt punctuation', () => {
  let calls = 0;
  const advisor = new LiveAdvisor({
    now: () => 1_000_200,
    advise: async () => { calls++; return { status: 'ready', advice: '出杀' }; },
  });
  advisor.ingest(event(1, '出牌阶段请选择1张卡牌'));
  advisor.ingest(event(2, '出牌阶段，请选择1张卡牌'));
  assert.equal(calls, 1);
  assert.equal(advisor.stats.canceled, 0);
});

test('gives an immediate conditional rescue cue when the dying role is not visible', () => {
  let calls = 0;
  const advisor = new LiveAdvisor({
    now: () => 1_000_200,
    advise: async () => { calls++; },
  });
  advisor.ingest(event(1, '曹不生命危急，需要1个桃。', '桃'));
  assert.equal(calls, 0);
  assert.equal(advisor.snapshot().status, 'ready');
  assert.match(advisor.snapshot().advice, /先确认濒死者身份/);
});
