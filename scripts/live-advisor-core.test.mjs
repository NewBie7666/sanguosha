import assert from 'node:assert/strict';
import test from 'node:test';

import {
  askLocalModel,
  buildContext,
  buildDecisionSignature,
  decisionChangeReason,
  normalizeCardName,
  validateChoice,
} from './live-advisor-core.mjs';
import { buildSkillHints } from './live-skill-catalog.mjs';

function event(prompt, hand = [
  { name: '閃', confidence: 0.98 },
  { name: '无懈可击', confidence: 0.96 },
]) {
  return {
    frame_id: 42,
    timestamp: '2026-09-24T12:00:00Z',
    state: { scene: 'decision_window', data: {
      decision: { prompt }, hand_cards: hand,
      players: {
        self: { role: '主公', role_confidence: 0.8, health: 2, visible_text: '界黄盖' },
        left: { role: '反贼', role_confidence: 1, health: 3, visible_text: '界夏侯惇' },
      },
    } },
  };
}

test('normalizes OCR card names and gives rules to a discard decision', () => {
  assert.equal(normalizeCardName('無懈可擊'), '无懈可击');
  const context = buildContext(event('弃牌阶段，选1张手牌'));
  assert.equal(context.kind, 'discard');
  assert.deepEqual(context.candidates.map((action) => action.id), ['discard-1', 'discard-2']);
  assert.equal(context.players.left.relation, '敌方');
  assert.match(context.rules['无懈可击'], /锦囊牌/);
});

test('does not advise when a card is uncertain', () => {
  const context = buildContext(event('弃牌阶段', [{ name: '殺', confidence: 0.31 }]));
  assert.equal(context.kind, 'insufficient');
  assert.deepEqual(context.candidates, []);
});

test('rejects choices outside current candidates and impossible rule claims', () => {
  const context = buildContext(event('弃牌阶段'));
  assert.throws(() => validateChoice(context, '{"choice_id":"discard-9","reason":"弃错"}'));
  assert.throws(() => validateChoice(context, '{"choice_id":"discard-1","reason":"无懈抵消杀"}'));
});

test('accepts a valid local model recommendation', async () => {
  const context = buildContext(event('弃牌阶段'));
  const fetchImpl = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"choice_id":"discard-2","reason":"留闪防敌方下一次杀"}' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const advice = await askLocalModel(context, { fetchImpl });
  assert.equal(advice.status, 'ready');
  assert.match(advice.advice, /无懈可击/);
  assert.equal(advice.frame_id, 42);
});

test('offers two-card discard combinations for an observed discard prompt', () => {
  const context = buildContext(event('弃牌阶段，选2张手牌，点确定弃置', [
    { name: '桃', confidence: 0.99 },
    { name: '诸葛连考', confidence: 0.94 },
    { name: '殺', confidence: 0.99 },
    { name: '閃', confidence: 0.99 },
  ]));
  assert.equal(context.kind, 'discard');
  assert.equal(context.candidates.length, 6);
  assert.equal(context.hand[1].name, '诸葛连弩');
  assert.match(context.candidates[0].label, /桃.*诸葛连弩/);
});

test('offers only visible enemies for a Slash target decision', () => {
  const context = buildContext(event('选择1名角色，作为杀的目标', [
    { name: '桃', confidence: 0.99 },
  ]));
  assert.equal(context.kind, 'target');
  assert.deepEqual(context.candidates.map((candidate) => candidate.id), ['target-left']);
});

test('recognizes the observed rescue and Zha Xiang skill prompts', () => {
  const rescue = buildContext(event('曹不生命危急，需要1个桃。', [
    { name: '桃', confidence: 0.99 },
  ]));
  assert.equal(rescue.kind, 'rescue');
  assert.deepEqual(rescue.candidates.map((candidate) => candidate.id), ['verify-dying-role']);
  const skill = buildContext(event('弃1张牌并失去1点体力，触发诈降使杀次数+1且红杀无法被闪'));
  assert.equal(skill.kind, 'skill_cost');
  assert.ok(skill.candidates.some((candidate) => candidate.id === 'skip-skill'));
});

test('does not recommend discarding the only Slash to gain extra Slash uses', () => {
  const context = buildContext(event('弃1张牌并失去1点体力，触发诈降使杀次数+1且红杀无法被闪', [
    { name: '火攻', confidence: 0.99 },
    { name: '殺', confidence: 0.99 },
    { name: '朱雀羽扇', confidence: 0.99 },
  ]));
  assert.deepEqual(context.candidates.map((candidate) => candidate.id), [
    'skill-discard-1', 'skill-discard-3', 'skip-skill',
  ]);
});

test('can advise a visible target even when hand OCR is incomplete', () => {
  const context = buildContext(event('选择1名有手牌的目标火攻，他给你看1张牌', [
    { name: '未识别牌', confidence: 0.52 },
  ]));
  assert.equal(context.kind, 'target');
  assert.deepEqual(context.candidates.map((candidate) => candidate.id), ['target-left']);
  assert.match(context.candidates[0].label, /火攻/);
});

test('limits a play suggestion to known cards when one card is unreadable', () => {
  const context = buildContext(event('出牌阶段，请选择1张卡牌', [
    { name: '未识别牌', confidence: 0.52 },
    { name: '殺', confidence: 0.99 },
  ]));
  assert.equal(context.kind, 'play');
  assert.equal(context.unreadable_card_count, 1);
  assert.deepEqual(context.candidates.map((candidate) => candidate.id), ['consider-2-left', 'end']);
});

test('decision signature changes when visible player state changes', () => {
  const firstEvent = event('出牌阶段，请选择1张卡牌', [{ name: '殺', confidence: 0.99 }]);
  const secondEvent = structuredClone(firstEvent);
  secondEvent.state.data.players.left.health = 1;
  const first = buildContext(firstEvent);
  const second = buildContext(secondEvent);
  assert.notEqual(buildDecisionSignature(first), buildDecisionSignature(second));
  assert.equal(decisionChangeReason(first, second), 'player_changed');
});

test('decision signature normalizes public log punctuation but reacts to new history', () => {
  const first = buildContext(event('出牌阶段，请选择1张卡牌'), ['左侧反贼出杀。']);
  const punctuationOnly = buildContext(event('出牌阶段，请选择1张卡牌'), ['左侧反贼出杀']);
  const changed = buildContext(event('出牌阶段，请选择1张卡牌'), ['左侧反贼使用桃']);
  assert.equal(buildDecisionSignature(first), buildDecisionSignature(punctuationOnly));
  assert.notEqual(buildDecisionSignature(first), buildDecisionSignature(changed));
  assert.equal(decisionChangeReason(first, changed), 'history_changed');
});

test('verified mobile skills provide timing and enter the model context', () => {
  const current = event('出牌阶段，请选择1张卡牌', [{ name: '杀', confidence: 0.99 }]);
  current.state.data.visible_skills = [
    { name: '勤王', confidence: 0.995 },
    { name: '战绝', confidence: 0.998 },
  ];
  const hints = buildSkillHints(current.state.data);
  assert.equal(hints.length, 2);
  assert.equal(hints[0].general, '刘谌');
  assert.match(hints[0].timing, /主公技/);
  assert.match(hints[1].timing, /全部手牌/);
  assert.equal(hints[1].availability, '出牌阶段可考虑');
  const context = buildContext(current);
  assert.deepEqual(context.visible_skills.map((skill) => skill.name), ['勤王', '战绝']);
  assert.equal(context.skill_rules.length, 2);
  assert.match(context.skill_rules[1].tactic, /手牌/);
});

test('skill hints do not assert availability when identity or conditions are missing', () => {
  const current = event('请使用1张杀');
  current.state.data.visible_skills = [{ name: '勤王', confidence: 0.99 }];
  assert.equal(buildSkillHints(current.state.data)[0].availability, '当前可留意');
  current.state.data.players.self.role = '反贼';
  assert.equal(buildSkillHints(current.state.data)[0].availability, '当前身份不满足主公技');
  current.state.data.players.self.role_confidence = 0.4;
  assert.equal(buildSkillHints(current.state.data)[0].availability, '发动条件待核对');
});

test('uncollected skills are shown without invented rules and skill changes invalidate advice', () => {
  const firstEvent = event('出牌阶段，请选择1张卡牌', [{ name: '杀', confidence: 0.99 }]);
  const secondEvent = structuredClone(firstEvent);
  secondEvent.state.data.visible_skills = [{ name: '新技能', confidence: 0.95 }];
  const hint = buildSkillHints(secondEvent.state.data)[0];
  assert.equal(hint.known, false);
  assert.match(hint.note, /尚未收录/);
  assert.equal(buildContext(secondEvent).skill_rules.length, 0);
  assert.notEqual(buildDecisionSignature(buildContext(firstEvent)), buildDecisionSignature(buildContext(secondEvent)));
  assert.equal(decisionChangeReason(buildContext(firstEvent), buildContext(secondEvent)), 'skills_changed');
});

test('recognizing Zhang Song provides both skills without waiting for buttons', () => {
  const current = event('请等待其他玩家');
  current.state.data.self_general = { name: '张松', confidence: 0.996 };
  current.state.data.players.self.health = 1;
  const hints = buildSkillHints(current.state.data);
  assert.deepEqual(hints.map((hint) => hint.name), ['强识', '献图']);
  assert.ok(hints.every((hint) => hint.observed_on_screen === false));
  assert.match(hints[1].note, /仅1血/);
  assert.equal(buildContext(current).skill_rules.length, 2);
  current.state.data.self_general.confidence = 0.5;
  assert.deepEqual(buildSkillHints(current.state.data), []);
});

test('Wolong skill rules require the standard general to avoid same-name variants', () => {
  const current = event('你可以将1张黑色手牌当【无懈可击】使用');
  current.state.data.visible_skills = [
    { name: '看破', confidence: 0.99 },
    { name: '火计', confidence: 0.99 },
    { name: '八阵', confidence: 0.99 },
  ];
  assert.ok(buildSkillHints(current.state.data).every((hint) => !hint.known));
  current.state.data.self_general = { name: '卧龙诸葛', confidence: 0.9 };
  const hints = buildSkillHints(current.state.data);
  assert.ok(hints.every((hint) => hint.known));
  assert.equal(hints.find((hint) => hint.name === '看破').availability, '当前可留意');
  assert.equal(buildContext(current).skill_rules.length, 3);
  current.state.data.self_general.name = '界卧龙诸葛';
  assert.ok(buildSkillHints(current.state.data).every((hint) => !hint.known));
});
