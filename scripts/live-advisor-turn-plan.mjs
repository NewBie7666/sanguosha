/**
 * Validate a complete play-phase plan produced from one observed hand.
 *
 * The validator intentionally stays independent from the live advisor.  It
 * only accepts the current, already-derived candidates and does not invent
 * card effects or infer hidden information.
 */

const SLASH_CARDS = new Set(['杀', '火杀', '雷杀']);
const DRAW_CARDS = new Set(['无中生有', '五谷丰登']);

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRecognizedCard(card, rules) {
  if (!isObject(card) || !Number.isInteger(card.index)) return false;
  const confidence = Number(card.confidence ?? 0);
  if (!Number.isFinite(confidence) || confidence < 0.7) return false;
  const name = String(card.name ?? '');
  return Boolean(name) && (Object.hasOwn(rules, name) || SLASH_CARDS.has(name));
}

function deriveCardIndex(candidate) {
  if (candidate.card_index !== undefined) {
    if (!Number.isInteger(candidate.card_index)) fail(`候选 ${candidate.id} 的 card_index 必须是整数`);
    return candidate.card_index;
  }
  const match = /^consider-(\d+)(?:-.+)?$/.exec(String(candidate.id ?? ''));
  return match ? Number(match[1]) : null;
}

function candidateName(candidate, card) {
  if (candidate.card_name !== undefined) {
    if (typeof candidate.card_name !== 'string' || !candidate.card_name.trim()) {
      fail(`候选 ${candidate.id} 的 card_name 无效`);
    }
    if (candidate.card_name !== card.name) {
      fail(`候选 ${candidate.id} 的 card_name 与第${card.index}张手牌不一致`);
    }
  }
  return card.name;
}

function validatePlanShape(context, parsed) {
  if (!isObject(context) || context.kind !== 'play') {
    fail('回合计划仅适用于出牌阶段');
  }
  if (!isObject(parsed)) fail('模型回合计划必须是对象');
  if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) {
    fail('模型回合计划缺少理由');
  }
  if (!Array.isArray(parsed.plan) || parsed.plan.length < 1 || parsed.plan.length > 6) {
    fail('回合计划必须包含1至6个步骤');
  }
  if (typeof parsed.choice_id !== 'string' || parsed.choice_id !== parsed.plan[0]) {
    fail('choice_id 必须等于计划的第一步');
  }
  if (!Array.isArray(parsed.reserve)) fail('reserve 必须是手牌索引数组');
  return parsed;
}

function planningNote(context, hasDrawStep) {
  const note = [
    '先核对识别出的手牌种类、序号与数量。',
    '后续步骤都是有条件的：每一步执行后须以游戏提示为准；手牌、玩家状态或公共历史变化时必须重新规划。',
  ];
  if (hasDrawStep) note.push('计划在抽牌后停止；新增手牌未知，抽牌完成后必须重新规划。');
  if (Number(context.unreadable_card_count ?? 0) > 0) {
    note.push(`当前有${Number(context.unreadable_card_count)}张手牌未识别，本计划仅基于已识别牌。`);
  }
  return note.join('');
}

/**
 * Validate a model's whole-turn ordering and return UI-ready plan text.
 *
 * @param {object} context Current buildContext() result.
 * @param {object} parsed Parsed model response with choice_id/reason/plan/reserve.
 */
export function validateTurnPlan(context, parsed) {
  validatePlanShape(context, parsed);

  const candidates = Array.isArray(context.candidates) ? context.candidates : [];
  const byId = new Map(candidates.map((candidate) => [candidate?.id, candidate]));
  const hand = Array.isArray(context.hand) ? context.hand : [];
  const handByIndex = new Map(hand.map((card) => [card?.index, card]));
  const rules = isObject(context.rules) ? context.rules : {};

  const planCandidates = [];
  const usedIds = new Set();
  const usedCardIndices = new Set();
  const slashCardIndices = new Set();
  let drawStepIndex = -1;

  for (let i = 0; i < parsed.plan.length; i += 1) {
    const id = parsed.plan[i];
    if (typeof id !== 'string' || !id) fail('计划步骤 ID 必须是非空字符串');
    if (usedIds.has(id)) fail(`计划重复使用候选 ${id}`);
    usedIds.add(id);

    const candidate = byId.get(id);
    if (!candidate) fail(`计划候选 ${id} 不存在于当前局面`);
    if (id === 'end' && i !== parsed.plan.length - 1) fail('end 只能作为计划最后一步');

    const cardIndex = id === 'end' ? null : deriveCardIndex(candidate);
    let card = null;
    if (id !== 'end') {
      if (!Number.isInteger(cardIndex)) fail(`候选 ${id} 缺少可核对的 card_index`);
      card = handByIndex.get(cardIndex);
      if (!card) fail(`候选 ${id} 引用了不存在的第${cardIndex}张手牌`);
      if (!isRecognizedCard(card, rules)) fail(`未识别手牌不能进入计划：第${cardIndex}张`);
      if (usedCardIndices.has(cardIndex)) fail(`第${cardIndex}张手牌不能用于多个计划步骤`);
      usedCardIndices.add(cardIndex);
      const name = candidateName(candidate, card);
      if (SLASH_CARDS.has(name)) slashCardIndices.add(cardIndex);
      if (DRAW_CARDS.has(name)) {
        if (drawStepIndex !== -1) fail('当前计划不能安排多次抽牌');
        drawStepIndex = i;
      }
    }

    planCandidates.push(candidate);
  }

  if (slashCardIndices.size > 1) {
    fail('当前缺少已用杀次数和装备状态，计划最多安排一张杀');
  }
  if (drawStepIndex !== -1 && drawStepIndex !== parsed.plan.length - 1) {
    fail('无中生有或五谷丰登后抽牌后必须停止计划并重排，不能继续安排动作或结束');
  }

  const reserveCards = [];
  const reserveIndices = new Set();
  for (const index of parsed.reserve) {
    if (!Number.isInteger(index)) fail('reserve 中的手牌索引必须是整数');
    if (reserveIndices.has(index)) fail(`reserve 重复使用第${index}张手牌`);
    reserveIndices.add(index);
    const card = handByIndex.get(index);
    if (!card) fail(`reserve 引用了不存在的第${index}张手牌`);
    if (!isRecognizedCard(card, rules)) fail(`未识别手牌不能伪装为保留牌：第${index}张`);
    if (usedCardIndices.has(index)) fail(`第${index}张手牌同时出现在计划和 reserve 中`);
    reserveCards.push(card);
  }

  const recognizedIndices = new Set(
    hand.filter((card) => isRecognizedCard(card, rules)).map((card) => card.index),
  );
  const coveredIndices = new Set([...usedCardIndices, ...reserveIndices]);
  for (const index of recognizedIndices) {
    if (!coveredIndices.has(index)) fail(`已识别的第${index}张手牌没有安排计划或保留`);
  }
  for (const index of coveredIndices) {
    if (!recognizedIndices.has(index)) fail(`第${index}张手牌不是可靠识别牌，不能纳入回合计划`);
  }

  const turnPlanText = planCandidates
    .map((candidate, index) => `${index + 1}. ${String(candidate.label ?? candidate.id)}`)
    .join('\n');
  const reserveText = reserveCards.length
    ? reserveCards.map((card) => `第${card.index}张【${card.name}】`).join('、')
    : '无';

  return {
    turn_plan: planCandidates,
    reserve_cards: reserveCards,
    turn_plan_text: turnPlanText,
    reserve_text: reserveText,
    planning_note: planningNote(context, drawStepIndex !== -1),
  };
}

