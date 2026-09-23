import type { AvailableAction, AiViewSnapshot } from '../client/headless/types';
import type { Card, ClientMessage } from '../engine/types';
import type { LegalAction, PublicLegalAction } from './types';

type MessageParams = Record<string, unknown>;

function copyMessage(message: ClientMessage): ClientMessage {
  return structuredClone(message);
}

function cardInHand(snapshot: AiViewSnapshot, cardId: string): Card | undefined {
  const self = snapshot.players.find((player) => player.index === snapshot.viewer);
  return self?.hand?.find((card) => card.id === cardId);
}

function visibleSelectableCard(snapshot: AiViewSnapshot, cardId: string): Card | undefined {
  return cardInHand(snapshot, cardId) ?? snapshot.pending?.cardSelection?.candidates.find((card) => card.id === cardId) as Card | undefined;
}

function messageHasPlaceholder(params: MessageParams): boolean {
  return Object.values(params).some((value) => Array.isArray(value) && value.length === 0);
}

function chooseCombinations<T>(values: T[], count: number, limit = 250): T[][] {
  if (count < 0 || count > values.length) return [];
  if (count === 0) return [[]];
  const result: T[][] = [];
  const visit = (start: number, chosen: T[]) => {
    if (result.length >= limit) return;
    if (chosen.length === count) {
      result.push([...chosen]);
      return;
    }
    for (let i = start; i <= values.length - (count - chosen.length); i++) {
      chosen.push(values[i]);
      visit(i + 1, chosen);
      chosen.pop();
      if (result.length >= limit) return;
    }
  };
  visit(0, []);
  return result;
}

function isLegalSeat(snapshot: AiViewSnapshot, seat: unknown): seat is number {
  return Number.isInteger(seat) && snapshot.players.some((player) => player.index === seat);
}

function concreteResponse(action: AvailableAction, snapshot: AiViewSnapshot): ClientMessage[] {
  const message = copyMessage(action.message);
  const params = message.params as MessageParams;
  const ownHandIds = new Set([
    ...(snapshot.players[snapshot.viewer]?.hand ?? []).map((card) => card.id),
    ...(snapshot.pending?.cardSelection?.candidates ?? []).map((card) => card.id),
  ]);

  if (Array.isArray(params['cardIds']) && params['cardIds'].length === 0) {
    if (action.category !== 'discard') return [];
    const selection = snapshot.pending?.cardSelection;
    if (!selection) return [];
    const candidates = selection.candidates;
    const chosenCount = Math.max(0, selection.min);
    return chooseCombinations(candidates, chosenCount).map((cards) => ({
      ...copyMessage(message),
      params: { ...params, cardIds: cards.map((card) => card.id) },
    }));
  }

  if (Array.isArray(params['targets']) && params['targets'].length === 0 && action.validTargets.length > 0) {
    const range = snapshot.pending?.targetSelection ?? { min: 1, max: 1 };
    const count = Math.max(1, range.min);
    if (count > range.max) return [];
    return chooseCombinations(action.validTargets, count).map((targets) => ({
      ...copyMessage(message),
      params: { ...params, targets, ...(targets.length === 1 ? { target: targets[0] } : {}) },
    }));
  }

  if (messageHasPlaceholder(params)) return [];

  if (typeof params['cardId'] === 'string' && !ownHandIds.has(params['cardId'])) {
    const publicPick =
      action.description.includes('(装备)') ||
      action.description.includes('(判定区)') ||
      action.description.startsWith('选【');
    if (!publicPick) return [];
  }
  if (Array.isArray(params['cardIds']) && !params['cardIds'].every((id) => typeof id === 'string' && ownHandIds.has(id))) {
    return [];
  }
  for (const key of ['target', 'targets']) {
    const value = params[key];
    if (typeof value === 'number' && !isLegalSeat(snapshot, value)) return [];
    if (Array.isArray(value) && !value.every((seat) => isLegalSeat(snapshot, seat))) return [];
  }
  if (action.validTargets.length > 0) {
    const targets = [params['target'], ...(Array.isArray(params['targets']) ? params['targets'] : [])].filter(
      (target): target is number => typeof target === 'number',
    );
    if (targets.some((target) => !action.validTargets.includes(target))) return [];
  }
  return [message];
}

function materialize(action: AvailableAction, snapshot: AiViewSnapshot): Array<{
  message: ClientMessage;
  targetSeat?: number;
  description: string;
}> {
  const original = copyMessage(action.message);
  const params = original.params as MessageParams;

  if (original.actionType === 'skip' || action.category === 'skip' || original.actionType === 'end') {
    return [{ message: original, description: action.description }];
  }

  if (action.category === 'selectChar') {
    const character = params['character'];
    const visibleCandidates = snapshot.pending?.candidates;
    const allowed = !visibleCandidates || visibleCandidates.some((candidate) => candidate.name === character);
    // The engine's viewer-scoped availableActions already materializes each selectable
    // character. Some pending snapshots omit the redundant candidate list, so the
    // server-generated action itself is the authoritative choice list in that case.
    return allowed && typeof character === 'string'
      ? [{ message: original, description: action.description }]
      : [];
  }

  if (action.category === 'discard' || action.category === 'respond') {
    return concreteResponse(action, snapshot).map((message) => {
      const responseParams = message.params as MessageParams;
      const chosenCards = Array.isArray(responseParams['cardIds'])
        ? (responseParams['cardIds'] as string[])
            .map((id) => visibleSelectableCard(snapshot, id))
            .filter((card): card is Card => !!card)
            .map((card) => `${card.name}(${card.suit}${card.rank})`)
        : [];
      const description = chosenCards.length
        ? `${action.description.replace(/（.*$/, '')}：${chosenCards.join('、')}`
        : action.description;
      return { message, description };
    });
  }

  // Phase-one play support: concrete ordinary card uses and end-phase actions only.
  // Transform, distribute, multi-slot skills and other incomplete templates stay private.
  if (action.category !== 'play') return [];
  const cardId = params['cardId'];
  if (typeof cardId !== 'string') return [];
  const card = cardInHand(snapshot, cardId);
  if (!card) return [];

  // 借刀杀人 needs two semantically different targets; the upstream action list does not
  // materialize both slots, so it is intentionally excluded rather than guessed.
  if (card.name === '借刀杀人') return [];

  if (action.validTargets.length > 0) {
    if (original.skillId !== card.name) return [];
    return action.validTargets.map((targetSeat) => {
      const message = copyMessage(original);
      const messageParams = message.params as MessageParams;
      if (card.type === '锦囊牌' && card.trickSubtype === '延时锦囊') {
        message.params = { ...messageParams, target: targetSeat };
      } else {
        message.params = { ...messageParams, targets: [targetSeat] };
      }
      return {
        message,
        targetSeat,
        description: `${action.description.replace(/选择目标.*/, '').trim()} → ${snapshot.players[targetSeat]?.name ?? `P${targetSeat}`}`,
      };
    });
  }

  if (card.type === '锦囊牌' && card.trickSubtype === '延时锦囊') return [];
  if (messageHasPlaceholder(params)) return [];
  return [{ message: original, description: action.description }];
}

/** Build a safe subset of fully materialized actions from the engine's richer templates. */
export function buildLegalActions(
  availableActions: AvailableAction[],
  snapshot: AiViewSnapshot,
): LegalAction[] {
  const result: LegalAction[] = [];
  const seen = new Set<string>();
  for (const candidate of availableActions) {
    for (const concrete of materialize(candidate, snapshot)) {
      const key = JSON.stringify(concrete.message);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        action_id: `action_${String(result.length + 1).padStart(3, '0')}`,
        type: concrete.message.actionType,
        description: concrete.description,
        ...(concrete.targetSeat !== undefined ? { target_seat: concrete.targetSeat } : {}),
        message: concrete.message,
      });
    }
  }
  // Some viewer-scoped prompt variants lack an action template (for example a
  // non-mandatory response with no matching card). A pass is safe only when the
  // current seat owns a blocking, non-mandatory, non-silent prompt.
  if (
    result.length === 0 &&
    snapshot.pending?.target === snapshot.viewer &&
    snapshot.pending.isBlocking &&
    snapshot.pending.mandatory !== true &&
    snapshot.pending.responseMode !== 'silent'
  ) {
    result.push({
      action_id: 'action_001',
      type: 'skip',
      description: '跳过当前可选回应',
      message: {
        skillId: '__skip',
        actionType: 'skip',
        ownerId: snapshot.viewer,
        params: {},
        baseSeq: 0,
      },
    });
  }
  return result;
}

export function toPublicLegalActions(actions: LegalAction[]): PublicLegalAction[] {
  return actions.map(({ message: _message, ...publicAction }) => publicAction);
}

export function chooseDeterministicFallback(actions: LegalAction[]): LegalAction | null {
  if (actions.length === 0) return null;
  return actions.find((action) => action.type === 'skip') ??
    actions.find((action) => action.type === 'end') ??
    actions[0];
}

export function parseActionId(rawText: string): string {
  const parsed: unknown = JSON.parse(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('model output must be a JSON object');
  }
  const value = (parsed as Record<string, unknown>)['action_id'];
  if (typeof value !== 'string' || !value.trim()) throw new Error('model output is missing action_id');
  return value;
}

export function resolveActionId(actionId: string, actions: LegalAction[]): LegalAction {
  const action = actions.find((candidate) => candidate.action_id === actionId);
  if (!action) throw new Error(`action_id ${actionId} is not in current legal_actions`);
  return action;
}
