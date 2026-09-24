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

test('keeps a suggestion while VisionBox captures an unchanged decision', async () => {
  let time = 1_000_100;
  const unchangedEvent = event(1);
  const advisor = new LiveAdvisor({
    now: () => time,
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => url.endsWith('/metrics')
        ? { running: true, capture_error: null, last_capture_at: new Date(time).toISOString() }
        : { events: [unchangedEvent] },
    }),
    advise: async () => ({ status: 'ready', advice: '出杀' }),
  });
  await advisor.poll();
  await Promise.resolve();
  time += 5_000;
  await advisor.poll();
  assert.equal(advisor.snapshot().status, 'ready');
  assert.equal(advisor.snapshot().advice, '出杀');
  assert.equal(advisor.snapshot().age_ms, 5_000);
  assert.equal(advisor.snapshot().capture_age_ms, 0);
});

test('hides a suggestion when VisionBox capture stops or its frame is old', async () => {
  let time = 1_000_100;
  const advisor = new LiveAdvisor({
    now: () => time,
    advise: async () => ({ status: 'ready', advice: '出杀' }),
  });
  advisor.ingest(event(1));
  await Promise.resolve();
  advisor.captureMetrics = {
    running: true, capture_error: null, last_capture_at: new Date(time).toISOString(),
  };
  time += 5_000;
  assert.equal(advisor.snapshot().status, 'stale');
  advisor.captureMetrics.last_capture_at = new Date(time).toISOString();
  advisor.captureMetrics.capture_error = 'window not found';
  assert.equal(advisor.snapshot().status, 'stale');
  advisor.captureMetrics.capture_error = null;
  advisor.captureMetrics.running = false;
  assert.equal(advisor.snapshot().status, 'stale');
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

test('does not cancel a model request for one transient waiting frame', () => {
  let time = 1_000_200;
  const pending = [];
  const advisor = new LiveAdvisor({
    now: () => time,
    advise: (_context, { signal }) => new Promise((resolve) => pending.push({ resolve, signal })),
  });
  advisor.ingest(event(1));
  advisor.ingest(event(2, '请等待其他玩家'));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].signal.aborted, false);
  assert.equal(advisor.stats.canceled, 0);
  assert.equal(advisor.snapshot().status, 'waiting');

  time += 200;
  advisor.ingest(event(3));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].signal.aborted, false);
  assert.equal(advisor.snapshot().status, 'thinking');
});

test('cancels after visual instability persists beyond the grace window', () => {
  let time = 1_000_200;
  const pending = [];
  const advisor = new LiveAdvisor({
    now: () => time,
    advise: (_context, { signal }) => new Promise((resolve) => pending.push({ resolve, signal })),
  });
  advisor.ingest(event(1));
  advisor.ingest(event(2, '请等待其他玩家'));
  time += 650;
  advisor.ingest(event(2, '请等待其他玩家'));
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(advisor.stats.canceled, 1);
  assert.equal(advisor.stats.cancel_reasons.unstable_state, 1);
  assert.equal(advisor.stats.last_cancel_reason, 'unstable_state');
});

test('player-state changes invalidate an in-flight recommendation', () => {
  const pending = [];
  const advisor = new LiveAdvisor({
    now: () => 1_000_200,
    advise: (_context, { signal }) => new Promise((resolve) => pending.push({ resolve, signal })),
  });
  const first = event(1);
  const second = event(2);
  second.state.data.players.left.health = 2;
  advisor.ingest(first);
  advisor.ingest(second);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(advisor.stats.cancel_reasons.player_changed, 1);
});

test('model timeout is tracked separately from state-driven cancellation', async () => {
  const timeout = new Error('timed out');
  timeout.name = 'TimeoutError';
  const advisor = new LiveAdvisor({
    now: () => 1_000_200,
    advise: async () => { throw timeout; },
  });
  advisor.ingest(event(1));
  await Promise.resolve();
  assert.equal(advisor.stats.errors, 1);
  assert.equal(advisor.stats.timeouts, 1);
  assert.equal(advisor.stats.canceled, 0);
});
