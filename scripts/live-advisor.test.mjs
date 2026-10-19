import assert from 'node:assert/strict';
import test from 'node:test';

import { LiveAdvisor, probeLocalModel } from './live-advisor.mjs';
import { validateChoice } from './live-advisor-core.mjs';

function event(frameId, prompt = '出牌阶段，请选择1张卡牌', hand = '杀') {
  return {
    plugin: 'sanguosha',
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

function plannedEvent(frameId, prompt = '出牌阶段') {
  const sample = event(frameId, prompt);
  sample.state.data.hand_cards = [
    { name: '杀', confidence: .99 }, { name: '八卦阵', confidence: .99 },
    { name: '闪', confidence: .99 },
  ];
  return sample;
}

function mockTurnPlan(context) {
  const { candidate, reason, ...plan } = validateChoice(context, JSON.stringify({
    choice_id: 'consider-1-left', reason: '先集火残血敌人，再考虑防御装备，留闪',
    plan: ['consider-1-left', 'consider-2'], reserve: [3],
  }));
  return { status: 'ready', kind: 'play', advice: candidate.label, reason, ...plan };
}

test('a selected target follows the whole-hand plan without another model call', async () => {
  let calls = 0;
  const advisor = new LiveAdvisor({ now: () => 1_000_500,
    advise: async (context) => { calls++; return mockTurnPlan(context); } });
  advisor.ingest(plannedEvent(1));
  await Promise.resolve();
  assert.equal(advisor.snapshot().turn_plan.length, 2);
  advisor.ingest(plannedEvent(2, '选择1名角色，作为杀的目标'));
  assert.equal(calls, 1);
  assert.equal(advisor.snapshot().source, 'turn_plan_cache');
  assert.match(advisor.snapshot().advice, /左侧/);
  assert.match(advisor.snapshot().turn_plan_text, /八卦阵/);
  advisor.ingest(plannedEvent(3));
  assert.equal(calls, 1);
  assert.match(advisor.snapshot().advice, /杀/);
});

test('hand changes discard the prior order and wait for a new plan', async () => {
  const pending = [];
  const advisor = new LiveAdvisor({ now: () => 1_000_500,
    advise: (context) => new Promise((resolve) => pending.push({ context, resolve })) });
  advisor.ingest(plannedEvent(1));
  pending[0].resolve(mockTurnPlan(pending[0].context));
  await Promise.resolve();
  const changed = plannedEvent(2);
  changed.state.data.hand_cards[1].name = '无中生有';
  advisor.ingest(changed);
  assert.equal(pending.length, 2);
  assert.equal(advisor.turnPlan, null);
  assert.equal(advisor.snapshot().turn_plan_text, undefined);
});

test('ambiguous same-name selected cards do not reuse a specific physical card plan', async () => {
  let calls = 0;
  const advisor = new LiveAdvisor({ now: () => 1_000_500, advise: async (context) => {
    calls++;
    if (context.kind !== 'play') return { status: 'ready', advice: '重新核对目标' };
    const { candidate, ...plan } = validateChoice(context, JSON.stringify({
      choice_id: 'consider-1-left', reason: '保留另一张杀',
      plan: ['consider-1-left', 'consider-2'], reserve: [3, 4],
    }));
    return { status: 'ready', advice: candidate.label, ...plan };
  } });
  const play = plannedEvent(1);
  play.state.data.hand_cards.push({ name: '杀', confidence: .99 });
  advisor.ingest(play);
  await Promise.resolve();
  const selected = structuredClone(play);
  selected.frame_id = 2;
  selected.timestamp = event(2).timestamp;
  selected.state.data.decision.prompt = '选择1名角色，作为杀的目标';
  advisor.ingest(selected);
  assert.equal(calls, 2);
  assert.equal(advisor.turnPlan, null);
});

test('skips the model when the visible decision is not actionable', () => {
  let calls = 0;
  const advisor = new LiveAdvisor({ now: () => 1_000_100, advise: async () => { calls++; } });
  advisor.ingest(event(1, '请等待其他玩家'));
  assert.equal(advisor.snapshot().status, 'waiting');
  assert.equal(calls, 0);
});

test('ignores generic VisionBox flows and clears a running Sanguosha request', async () => {
  const pending = [];
  const advisor = new LiveAdvisor({
    now: () => 1_000_200,
    advise: (_context, { signal }) => new Promise((resolve) => pending.push({ resolve, signal })),
  });
  advisor.ingest(event(1));
  assert.equal(pending.length, 1);

  const generic = { ...event(2, '请等待其他玩家'), plugin: 'generic-text' };
  advisor.ingest(generic);
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(advisor.stats.cancel_reasons.plugin_changed, 1);
  assert.equal(advisor.snapshot().status, 'waiting');
  assert.match(advisor.snapshot().reason, /不是三国杀/);

  pending[0].resolve({ status: 'ready', advice: '过期三国杀建议' });
  await Promise.resolve();
  assert.equal(advisor.snapshot().advice, undefined);
  assert.equal(advisor.lastEvent, null);
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

test('shows skill timing while waiting but hides it with a stale capture', () => {
  let time = 1_000_100;
  const advisor = new LiveAdvisor({ now: () => time, advise: async () => ({ status: 'ready' }) });
  const visible = event(1, '请等待其他玩家');
  visible.state.data.visible_skills = [{ name: '战绝', confidence: 0.99 }];
  advisor.ingest(visible);
  assert.equal(advisor.snapshot().status, 'waiting');
  assert.equal(advisor.snapshot().skill_hints[0].name, '战绝');
  time += 5_000;
  assert.equal(advisor.snapshot().status, 'stale');
  assert.equal(advisor.snapshot().skill_hints, undefined);
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

test('model indicator requires the configured model to appear in the local model list', async () => {
  const available = await probeLocalModel(async () => new Response(JSON.stringify({
    data: [{ id: 'qwen/qwen3-14b' }],
  }), { status: 200 }));
  assert.equal(available.connected, true);
  const missing = await probeLocalModel(async () => new Response(JSON.stringify({
    data: [{ id: 'other-model' }],
  }), { status: 200 }));
  assert.equal(missing.connected, false);
  const offline = await probeLocalModel(async () => { throw new Error('offline'); });
  assert.equal(offline.connected, false);
});

test('model indicator distinguishes downloaded and loaded LM Studio models', async () => {
  for (const state of ['not-loaded', 'loaded']) {
    const status = await probeLocalModel(async () => new Response(JSON.stringify({
      data: [{ id: 'qwen/qwen3-14b', state }],
    }), { status: 200 }));
    assert.equal(status.connected, state === 'loaded');
    assert.match(status.reason, state === 'loaded' ? /已加载/ : /未加载/);
  }
});

test('model indicator reports unknown readiness on a compatible API without native status', async () => {
  const status = await probeLocalModel(async (url) => url.includes('/api/v0/')
    ? new Response('', { status: 404 })
    : new Response(JSON.stringify({ data: [{ id: 'qwen/qwen3-14b' }] })));
  assert.equal(status.connected, true);
  assert.match(status.reason, /加载状态未知/);
});
