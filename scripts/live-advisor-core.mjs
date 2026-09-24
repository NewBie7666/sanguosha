import { CARD_DESCRIPTIONS } from '../src/engine/data/card-defs/description.ts';
import { buildSkillHints } from './live-skill-catalog.mjs';

const TRADITIONAL = new Map(Object.entries({
  殺: '杀', 閃: '闪', 無: '无', 擊: '击', 鐵: '铁', 連: '连', 環: '环',
  過: '过', 橋: '桥', 順: '顺', 牽: '牵', 盧: '卢', 諸: '诸', 葛: '葛',
  銀: '银', 獅: '狮', 萬: '万', 齊: '齐', 發: '发', 鋒: '锋',
}));
const SINGLE_TARGET_CARDS = new Set([
  '杀', '火杀', '雷杀', '过河拆桥', '顺手牵羊', '决斗', '火攻', '乐不思蜀', '兵粮寸断',
]);
const SLASH_CARDS = new Set(['杀', '火杀', '雷杀']);
const SEAT_LABELS = { left: '左侧', top: '上方', right: '右侧' };
const CARD_ALIASES = new Map([
  ['诸葛连考', '诸葛连弩'],
  ['诸葛连', '诸葛连弩'],
]);

export function normalizeCardName(value) {
  const normalized = [...String(value ?? '').trim()].map((char) => TRADITIONAL.get(char) ?? char).join('');
  return CARD_ALIASES.get(normalized) ?? normalized;
}

export function normalizeDecisionText(value) {
  return String(value ?? '').replace(/[\s，。,.、：:；;！!？?]/g, '');
}

function stableHand(context) {
  return (context.hand ?? []).map((card) => normalizeCardName(card.name));
}

function stablePlayers(context) {
  return Object.entries(context.players ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([seat, player]) => [
      seat,
      Number(player.role_confidence ?? 0) >= 0.7 ? player.role ?? null : null,
      player.health ?? null,
      player.relation ?? '未知',
    ]);
}

function stableCandidates(context) {
  return (context.candidates ?? []).map((candidate) => candidate.id).sort();
}

function stableSkills(context) {
  return {
    self_general: context.self_general ?? null,
    names: [...new Set([
      ...(context.visible_skills ?? []).map((skill) => skill.name),
      ...(context.skill_rules ?? []).map((skill) => skill.name),
    ])].sort(),
  };
}

function stableHistory(context) {
  return (context.public_history ?? [])
    .map((entry) => normalizeDecisionText(entry))
    .filter(Boolean)
    .slice(-8);
}

export function buildDecisionSignature(context) {
  return JSON.stringify({
    kind: context.kind,
    prompt: normalizeDecisionText(context.prompt),
    hand: stableHand(context),
    players: stablePlayers(context),
    candidates: stableCandidates(context),
    visible_skills: stableSkills(context),
    public_history: stableHistory(context),
  });
}

export function decisionChangeReason(previous, current) {
  if (!previous) return 'initial';
  if (previous.kind !== current.kind) return 'kind_changed';
  if (normalizeDecisionText(previous.prompt) !== normalizeDecisionText(current.prompt)) return 'prompt_changed';
  if (JSON.stringify(stableHand(previous)) !== JSON.stringify(stableHand(current))) return 'hand_changed';
  if (JSON.stringify(stablePlayers(previous)) !== JSON.stringify(stablePlayers(current))) return 'player_changed';
  if (JSON.stringify(stableCandidates(previous)) !== JSON.stringify(stableCandidates(current))) return 'candidates_changed';
  if (JSON.stringify(stableSkills(previous)) !== JSON.stringify(stableSkills(current))) return 'skills_changed';
  if (JSON.stringify(stableHistory(previous)) !== JSON.stringify(stableHistory(current))) return 'history_changed';
  return 'decision_changed';
}

function relation(selfRole, otherRole) {
  if (!selfRole || !otherRole) return '未知';
  if (selfRole === '内奸') return '待判断';
  if (selfRole === '反贼') return otherRole === '反贼' ? '己方' : '敌方';
  if (selfRole === '主公' || selfRole === '忠臣') {
    return otherRole === '主公' || otherRole === '忠臣' ? '己方' : '敌方';
  }
  return '未知';
}

export function buildContext(event, publicHistory = []) {
  const state = event?.state;
  const data = state?.data ?? {};
  const prompt = String(data.decision?.prompt ?? '').trim();
  const rawPlayers = data.players ?? {};
  const selfRole = rawPlayers.self?.role_confidence >= 0.7 ? rawPlayers.self.role : null;
  const players = Object.fromEntries(
    Object.entries(rawPlayers).map(([seat, player]) => [seat, {
      role: player.role,
      role_confidence: player.role_confidence,
      health: player.health,
      visible_text: player.visible_text,
      relation: seat === 'self' ? '自己' : relation(selfRole, player.role),
    }]),
  );
  const hand = (data.hand_cards ?? []).map((card, index) => ({
    index: index + 1,
    name: normalizeCardName(card.name),
    confidence: Number(card.confidence ?? 0),
  }));
  const knownHand = hand.filter((card) => card.confidence >= 0.7 && !card.name.includes('未识别'));
  const unknownHand = knownHand.length !== hand.length;
  const rules = Object.fromEntries(
    knownHand.map((card) => [card.name, CARD_DESCRIPTIONS[card.name] ?? '牌效未收录，需以游戏提示为准']),
  );
  const skillHints = buildSkillHints(data);
  const selfGeneral = Number(data.self_general?.confidence ?? 0) >= 0.85
    ? data.self_general.name : null;
  const common = {
    frame_id: event.frame_id,
    observed_at: event.timestamp,
    prompt,
    hand,
    unreadable_card_count: hand.length - knownHand.length,
    players,
    rules,
    self_general: selfGeneral,
    visible_skills: skillHints.filter((skill) => skill.observed_on_screen)
      .map(({ name, confidence }) => ({ name, confidence })),
    skill_rules: skillHints.filter((skill) => skill.known).map((skill) => ({
      name: skill.name,
      general: skill.general,
      timing: skill.timing,
      effect: skill.effect,
      tactic: skill.tactic,
      availability: skill.availability,
      observed_on_screen: skill.observed_on_screen,
      note: skill.note,
    })),
    public_history: publicHistory.slice(-8),
  };
  if (!selfRole) {
    return { ...common, kind: 'insufficient', reason: '尚未可靠识别自己的身份', candidates: [] };
  }

  let kind;
  let candidates;
  if (/诈降/.test(prompt) && /失去.*体力/.test(prompt)) {
    if (!hand.length || unknownHand) {
      return { ...common, kind: 'insufficient', reason: '诈降弃牌代价下，手牌尚未完整识别', candidates: [] };
    }
    kind = 'skill_cost';
    const slashCount = hand.filter((card) => SLASH_CARDS.has(card.name)).length;
    candidates = hand.filter((card) => !SLASH_CARDS.has(card.name) || slashCount > 1).map((card) => ({
      id: `skill-discard-${card.index}`,
      label: `若决定发动诈降，弃第${card.index}张【${card.name}】并承担失去体力的代价`,
      card_name: card.name,
      requires_validation: true,
    }));
    candidates.push({ id: 'skip-skill', label: '不发动诈降，保留体力与手牌', requires_validation: true });
  } else if (/需要.?个桃|需要.*桃.*救|濒死.*桃/.test(prompt)) {
    if (!knownHand.some((card) => card.name === '桃') && unknownHand) {
      return { ...common, kind: 'insufficient', reason: '救援窗口有手牌未识别，请核对是否有桃', candidates: [] };
    }
    kind = 'rescue';
    const dyingName = prompt.match(/^(.+?)(?:生命危急|濒死)/)?.[1]?.trim();
    const dyingPlayer = dyingName && Object.values(players).find((player) =>
      player.visible_text && (player.visible_text.includes(dyingName) || dyingName.includes(player.visible_text)),
    );
    if (!dyingPlayer || !['己方', '敌方', '自己'].includes(dyingPlayer.relation)) {
      return {
        ...common, kind,
        candidates: [{
          id: 'verify-dying-role',
          label: '先确认濒死者身份：己方优先用桃救援；敌方通常保留桃',
          requires_validation: true,
        }],
      };
    }
    candidates = knownHand.filter((card) => card.name === '桃').map((card) => ({
      id: `rescue-${card.index}`,
      label: `使用第${card.index}张【桃】救援；先核对濒死者身份`,
      card_name: '桃',
      requires_validation: true,
    }));
    candidates.push({ id: 'decline', label: '不使用桃，保留手牌', requires_validation: true });
  } else if (/选择.*(?:名|个).*角色.*(?:杀的目标|作为杀的目标)|选择.*目标火攻/.test(prompt)) {
    kind = 'target';
    const targetCard = /火攻/.test(prompt) ? '火攻' : '杀';
    candidates = Object.entries(players).filter(([, player]) =>
      player.relation === '敌方' && player.role_confidence >= 0.7,
    ).map(([seat, player]) => ({
      id: `target-${seat}`,
      label: `选${SEAT_LABELS[seat] ?? seat}${player.role}（${player.health ?? '?'}血）为${targetCard}目标；须在游戏内核对可选性`,
      target: seat,
      requires_validation: true,
    }));
    if (!candidates.length) {
      return { ...common, kind: 'insufficient', reason: '没有可靠识别到可选的敌方目标', candidates: [] };
    }
  } else if (/弃牌|弃置.*(?:张|手牌)|选.*弃置/.test(prompt)) {
    if (!hand.length || unknownHand) {
      return { ...common, kind: 'insufficient', reason: '弃牌时手牌尚未完整识别', candidates: [] };
    }
    const countText = prompt.match(/(?:选|弃|弃置)([一二两三四五六\d]+)张/)?.[1];
    const discardCount = ({ 一: 1, 二: 2, 两: 2 })[countText] ?? Number(countText ?? 1);
    if (![1, 2].includes(discardCount)) {
      return { ...common, kind: 'insufficient', reason: '当前弃牌数量尚未可靠识别', candidates: [] };
    }
    kind = 'discard';
    candidates = discardCount === 1
      ? hand.map((card) => ({
        id: `discard-${card.index}`, label: `弃第${card.index}张【${card.name}】`,
        card_name: card.name,
      }))
      : hand.flatMap((first, i) => hand.slice(i + 1).map((second) => ({
        id: `discard-${first.index}-${second.index}`,
        label: `弃第${first.index}张【${first.name}】和第${second.index}张【${second.name}】`,
        card_names: [first.name, second.name],
      })));
  } else if (/请.*(?:出|打出|使用).*闪/.test(prompt)) {
    if (!knownHand.some((card) => card.name === '闪') && unknownHand) {
      return { ...common, kind: 'insufficient', reason: '有手牌未识别，请核对是否有闪', candidates: [] };
    }
    kind = 'respond';
    candidates = knownHand.filter((card) => card.name === '闪').map((card) => ({
      id: `flash-${card.index}`, label: `打出第${card.index}张【闪】`, card_name: '闪',
    }));
    candidates.push({ id: 'decline', label: '不打出闪（承担后果）' });
  } else if (/出牌阶段/.test(prompt)) {
    if (!knownHand.length) {
      return { ...common, kind: 'insufficient', reason: '尚未识别到可供分析的手牌', candidates: [] };
    }
    kind = 'play';
    const enemySeats = Object.entries(players).filter(([, player]) =>
      player.relation === '敌方' && player.role_confidence >= 0.7,
    );
    candidates = knownHand.filter((card) => !['闪', '无懈可击'].includes(card.name)).flatMap((card) => {
      if (SINGLE_TARGET_CARDS.has(card.name) && enemySeats.length) {
        return enemySeats.map(([seat, player]) => ({
          id: `consider-${card.index}-${seat}`,
          label: `考虑第${card.index}张【${card.name}】对${SEAT_LABELS[seat] ?? seat}${player.role}（${player.health ?? '?'}血）；目标与距离须在游戏内核对`,
          card_name: card.name,
          target: seat,
          requires_validation: true,
        }));
      }
      return [{
        id: `consider-${card.index}`,
        label: `考虑第${card.index}张【${card.name}】；实际可用性须在游戏内核对`,
        card_name: card.name,
        requires_validation: true,
      }];
    });
    candidates.push({
      id: 'end',
      label: unknownHand ? '保留手牌并结束出牌；先核对未识别的手牌' : '保留手牌并结束出牌',
      requires_validation: unknownHand,
    });
  } else {
    return { ...common, kind: 'waiting', reason: '当前没有已识别的可操作提示', candidates: [] };
  }
  return { ...common, kind, candidates };
}

export function buildMessages(context) {
  return [
    { role: 'system', content: [
      '你是三国杀身份局实战顾问。先按已知牌效排除错误用法，再比较候选对胜率的影响。',
      '考虑存活风险、敌我、后续回合机会成本、集火和武将技能时机；不要仅复述规则。',
      '优先保护己方濒死者；攻击时比较目标血量、后续集火机会与己方风险；防御牌和桃的留存价值随自己血量上升。',
      '本地牌效是参考，当前客户端可用目标、距离和技能以游戏提示为准。',
      '救援提示若未识别濒死者身份，不得臆测其敌我；应在理由中说明按身份决定。',
      '若有未识别手牌，只能就已识别的手牌给出暂定建议，理由中须说明有牌未识别。',
      '屏幕识别可能有误，未知信息不得臆造；角色技能若无文字说明，只可标注待核对。',
      '技能资料仅覆盖已核实的移动版技能；不得把“可考虑”当作确定可发动，必须核对游戏按钮与未识别条件。',
      '按武将识别推得的技能可能未显示按钮；不可断定此刻可以发动。',
      '只输出JSON：{"choice_id":"候选ID","reason":"具体局势理由，不超过50字"}。/no_think',
    ].join('') },
    { role: 'user', content: JSON.stringify(context) + '/no_think' },
  ];
}

export function validateChoice(context, rawText) {
  const parsed = JSON.parse(rawText);
  const candidate = context.candidates.find((item) => item.id === parsed.choice_id);
  if (!candidate) throw new Error('模型未从当前候选中选择');
  const reason = String(parsed.reason ?? '').trim();
  if (!reason || reason.length > 100) throw new Error('模型没有给出可核对的简短理由');
  if (/无懈.{0,12}(抵消|挡住|防住).{0,8}杀/.test(reason) && !/不能|无法/.test(reason)) {
    throw new Error('模型把无懈可击误用于普通杀');
  }
  return { candidate, reason };
}

export async function askLocalModel(context, {
  fetchImpl = fetch,
  modelUrl = 'http://127.0.0.1:1234/v1/chat/completions',
  signal,
} = {}) {
  const started = performance.now();
  const response = await fetchImpl(modelUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen/qwen3-14b', messages: buildMessages(context),
      temperature: 0.1, max_tokens: 120, stream: false,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'live_advice', strict: true,
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              choice_id: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['choice_id', 'reason'],
          },
        },
      },
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 250);
    throw new Error(`本机模型请求失败：${response.status} ${detail}`);
  }
  const payload = await response.json();
  const rawText = payload.choices?.[0]?.message?.content;
  if (typeof rawText !== 'string') throw new Error('本机模型未返回文字');
  const { candidate, reason } = validateChoice(context, rawText);
  return {
    status: 'ready', kind: context.kind, frame_id: context.frame_id,
    observed_at: context.observed_at, advice: candidate.label,
    reason, requires_validation: candidate.requires_validation === true,
    unreadable_card_count: context.unreadable_card_count,
    model_ms: Math.round(performance.now() - started),
  };
}
