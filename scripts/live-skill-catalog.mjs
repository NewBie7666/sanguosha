// Mobile game rules verified against the official character page linked per entry.
// Keep this catalog version-specific: similarly named skills in other editions may differ.
const SKILLS = {
  战绝: {
    general: '刘谌',
    timing: '出牌阶段可将全部手牌视为【决斗】使用；同一阶段因此摸到至少两张牌后，本回合不能再发动。',
    effect: '使用后，你和已受伤的角色各摸一张牌。',
    tactic: '先用掉不想投入决斗的关键牌；比较目标手牌与血量，留意双方摸牌收益。',
    source_url: 'https://www.sanguosha.cn/hero-detail-188.html',
  },
  勤王: {
    general: '刘谌',
    timing: '主公技；需要使用或打出【杀】且有其他蜀势力角色时，可弃一张牌发动。',
    effect: '其他蜀势力角色可依次选择是否打出【杀】；打出者摸一张牌。',
    tactic: '在需要【杀】而自己缺牌时留意；先确认有其他蜀势力角色，并衡量弃牌代价。',
    source_url: 'https://www.sanguosha.cn/hero-detail-188.html',
  },
  强识: {
    general: '张松',
    timing: '自己的出牌阶段开始时，可展示一名其他角色的一张手牌。',
    effect: '本回合每次使用与展示牌同类别的牌时，可摸一张牌。',
    tactic: '优先看手牌少、牌类更容易判断的目标，并规划本回合能连续使用的同类牌。',
    source_url: 'https://www.sanguosha.cn/index.php/pc/hero-detail-179.html',
  },
  献图: {
    general: '张松',
    timing: '其他角色的出牌阶段开始时，可摸两张牌，再交给该角色两张牌。',
    effect: '该阶段结束时，若那名角色本阶段未杀死过角色，你失去1点体力。',
    tactic: '优先考虑有把握击杀的己方角色；自己血量低时，先衡量失去体力的风险。',
    source_url: 'https://www.sanguosha.cn/index.php/pc/hero-detail-179.html',
  },
};

export function buildSkillHints(data = {}) {
  const visible = (data.visible_skills ?? [])
    .filter((skill) => Number(skill.confidence ?? 0) >= 0.8 && /^[\u4e00-\u9fff]{2,4}$/.test(skill.name ?? ''))
    .map((skill) => ({ ...skill, observed_on_screen: true }));
  const general = Number(data.self_general?.confidence ?? 0) >= 0.85
    ? data.self_general.name : null;
  const fromGeneral = Object.entries(SKILLS)
    .filter(([, rule]) => rule.general === general)
    .map(([name]) => ({ name, confidence: data.self_general.confidence, observed_on_screen: false }));
  const prompt = String(data.decision?.prompt ?? '');
  const role = Number(data.players?.self?.role_confidence ?? 0) >= 0.7
    ? data.players.self.role : null;
  const seen = new Set();
  return [...visible, ...fromGeneral].filter((skill) => {
    if (seen.has(skill.name)) return false;
    seen.add(skill.name);
    return true;
  }).map((skill) => {
    const rule = SKILLS[skill.name];
    if (!rule) return {
      name: skill.name,
      confidence: Number(skill.confidence),
      observed_on_screen: skill.observed_on_screen,
      known: false,
      availability: '规则待核对',
      note: '尚未收录该移动版技能；请以游戏内技能说明为准。',
    };
    let availability = '发动条件待核对';
    let note = '还需以游戏内可用按钮及技能状态核对。';
    if (skill.name === '勤王') {
      if (role && role !== '主公') {
        availability = '当前身份不满足主公技';
        note = '识别到自己的身份不是主公；若身份识别有误，请核对。';
      } else if (role === '主公' && /(?:使用|打出|请出|出牌).*杀|杀.*(?:响应|目标)/.test(prompt)) {
        availability = '当前可留意';
        note = '仍需确认有其他蜀势力角色，并核对可弃的牌。';
      } else {
        note = '出现使用或打出【杀】的需求时，再核对其他蜀势力角色和弃牌。';
      }
    } else if (skill.name === '战绝') {
      if (/出牌阶段/.test(prompt) && (data.hand_cards ?? []).length > 0) {
        availability = '出牌阶段可考虑';
        note = '要投入全部手牌；本阶段已通过此技能摸牌的数量尚未识别。';
      } else {
        note = '需有手牌，并在游戏允许使用【决斗】时核对按钮。';
      }
    } else if (skill.name === '强识') {
      availability = /强识/.test(prompt) ? '当前可留意' : '留意下次出牌阶段开始';
      note = skill.observed_on_screen
        ? '已看到技能按钮；仍需核对能否选择目标。'
        : '按武将识别显示；当前没有识别到可发动按钮。';
    } else if (skill.name === '献图') {
      availability = /献图|其他角色.*出牌阶段开始/.test(prompt)
        ? '当前可留意' : '留意其他角色出牌阶段开始';
      note = Number(data.players?.self?.health ?? 0) === 1
        ? '你目前仅1血；若受赠者本阶段没有击杀，你会失去1体力。'
        : '发动前核对受赠者能否在该阶段击杀，以及自己的血量。';
    }
    return {
      name: skill.name,
      confidence: Number(skill.confidence),
      observed_on_screen: skill.observed_on_screen,
      known: true,
      general: rule.general,
      availability,
      timing: rule.timing,
      effect: rule.effect,
      tactic: rule.tactic,
      note,
      source_url: rule.source_url,
    };
  });
}
