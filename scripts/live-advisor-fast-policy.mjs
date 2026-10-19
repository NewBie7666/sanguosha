/**
 * Small, deterministic policy for decisions that can be made safely from the
 * visible state alone. It deliberately avoids opponent hidden-card estimates,
 * character-specific rules, and any action that needs an unobserved target.
 */

const FAST_CONFIDENCE = 0.9;
const LIFE_SAVING_CARDS = new Set(['桃', '闪', '无懈可击']);
const KEEP_VALUES = new Map([
  ['桃', 100],
  ['闪', 90],
  ['无懈可击', 88],
  ['无中生有', 82],
  ['酒', 78],
  ['乐不思蜀', 75],
  ['兵粮寸断', 75],
  ['过河拆桥', 73],
  ['顺手牵羊', 73],
  ['杀', 64],
  ['火杀', 66],
  ['雷杀', 66],
  ['决斗', 67],
  ['火攻', 68],
  ['铁索连环', 70],
  ['南蛮入侵', 66],
  ['万箭齐发', 66],
  ['借刀杀人', 65],
  ['桃园结义', 62],
  ['五谷丰登', 62],
]);

function scoreMs(started) {
  return Math.round((performance.now() - started) * 100) / 100;
}

function abstain(started, reason) {
  return { status: 'abstain', reason, policy_ms: scoreMs(started) };
}

function visibleCard(context, index) {
  return context.hand?.find((card) => card.index === index);
}

function isHighConfidence(card) {
  return Boolean(
    card
      && Number(card.confidence ?? 0) >= FAST_CONFIDENCE
      && card.name
      && !String(card.name).includes('未识别'),
  );
}

function candidateCardNames(candidate) {
  if (Array.isArray(candidate.card_names)) return candidate.card_names;
  if (candidate.card_name) return [candidate.card_name];
  return [];
}

function discardCandidates(context) {
  return (context.candidates ?? []).filter((candidate) => candidate.id.startsWith('discard-'));
}

function discardScore(candidate) {
  const names = candidateCardNames(candidate);
  if (!names.length || names.some((name) => !KEEP_VALUES.has(name))) return null;
  return names.reduce((sum, name) => sum + KEEP_VALUES.get(name), 0);
}

function makeFastResult(context, candidate, reason, started) {
  const policyMs = scoreMs(started);
  const capturedAt = Date.parse(context.capture_at ?? '');
  return {
    status: 'ready',
    source: 'fast_policy',
    policy: 'visible-card-keep-value',
    kind: context.kind,
    frame_id: context.frame_id,
    observed_at: context.observed_at,
    advice: candidate.label,
    reason,
    requires_validation: true,
    unreadable_card_count: context.unreadable_card_count,
    policy_ms: policyMs,
    capture_to_advice_ms: Number.isFinite(capturedAt)
      ? Math.max(0, Date.now() - capturedAt) : null,
  };
}

function evaluateDiscard(context, started) {
  const candidates = discardCandidates(context);
  if (!candidates.length) return abstain(started, '当前没有可核对的弃牌候选');

  // Every card participating in a fast decision must be clearly readable.
  const allCardsVisible = (context.hand ?? []).every(isHighConfidence);
  if (!allCardsVisible) return abstain(started, '弃牌中有手牌识别置信度不足');

  const scored = candidates
    .map((candidate) => ({ candidate, value: discardScore(candidate) }))
    .filter((entry) => entry.value !== null)
    .sort((left, right) => left.value - right.value);
  if (scored.length !== candidates.length) {
    return abstain(started, '存在未收录牌名，不能安全估计保留价值');
  }
  if (scored.length < 2) return abstain(started, '弃牌候选不足，暂不自动判断');

  const [best, second] = scored;
  const bestNames = candidateCardNames(best.candidate);
  // Never spend a life-saving card through the fast path. A complex hand is
  // left for the model even when a numerical value happens to be lower.
  if (bestNames.some((name) => LIFE_SAVING_CARDS.has(name))) {
    return abstain(started, '最低保留价值候选含桃、闪或无懈可击');
  }
  if (second.value - best.value < 10) {
    return abstain(started, '最低保留价值差距不足，交给局势分析');
  }
  return makeFastResult(
    context,
    best.candidate,
    `仅依据已识别手牌的保留价值，优先保留桃、闪和无懈可击；本次建议弃用${bestNames.join('、')}`,
    started,
  );
}

function rescueRelation(context) {
  const prompt = String(context.prompt ?? '');
  if (/^(你|自己)/.test(prompt)) return '自己';
  const name = prompt.match(/^(.+?)(?:生命危急|濒死)/)?.[1]?.trim();
  if (!name) return null;
  const matches = Object.values(context.players ?? {}).filter((player) =>
    player.visible_text
      && (String(player.visible_text).includes(name) || name.includes(String(player.visible_text)))
      && Number(player.role_confidence ?? 0) >= 0.7,
  );
  if (matches.length !== 1) return null;
  return ['自己', '己方'].includes(matches[0].relation) ? matches[0].relation : null;
}

function evaluateRescue(context, started) {
  const relation = rescueRelation(context);
  if (!relation) {
    return abstain(started, '濒死者未可靠识别为自己或己方，先核对身份');
  }
  const candidate = (context.candidates ?? []).find((item) => item.id.startsWith('rescue-'));
  if (!candidate) return abstain(started, '未可靠识别到可用的桃');
  const cardIndex = Number(candidate.id.slice('rescue-'.length));
  const card = visibleCard(context, cardIndex);
  if (!isHighConfidence(card) || card.name !== '桃') {
    return abstain(started, '桃的识别置信度不足，不能确认可用');
  }
  return makeFastResult(
    context,
    candidate,
    `濒死者已可靠识别为${relation}，使用已识别的桃优先保命；仍需在游戏按钮中核对`,
    started,
  );
}

function evaluateFlash(context, started) {
  const health = Number(context.players?.self?.health);
  if (!Number.isFinite(health) || health > 1) {
    return abstain(started, '当前血量不足以确认出闪的即时收益');
  }
  const candidate = (context.candidates ?? []).find((item) => item.id.startsWith('flash-'));
  if (!candidate) return abstain(started, '未可靠识别到可用的闪');
  const cardIndex = Number(candidate.id.slice('flash-'.length));
  const card = visibleCard(context, cardIndex);
  if (!isHighConfidence(card) || card.name !== '闪') {
    return abstain(started, '闪的识别置信度不足，不能确认可用');
  }
  return makeFastResult(
    context,
    candidate,
    `当前为${health}血，出闪可直接避免本次伤害；仍需在游戏按钮中核对`,
    started,
  );
}

/**
 * Return a ready result for a safe visible-only decision, or an abstention
 * object so the caller can continue with the model / verification path.
 */
export function evaluateFastPolicy(context) {
  const started = performance.now();
  if (!context || !['discard', 'rescue', 'respond'].includes(context.kind)) {
    return abstain(started, '当前操作不在快速策略覆盖范围');
  }
  if (context.kind === 'discard') return evaluateDiscard(context, started);
  if (context.kind === 'rescue') return evaluateRescue(context, started);
  return evaluateFlash(context, started);
}

export const FAST_POLICY_CONFIDENCE = FAST_CONFIDENCE;
