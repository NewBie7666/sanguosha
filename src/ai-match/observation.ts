import type { AiViewSnapshot } from '../client/headless/types';
import type { EquipSlot } from '../engine/types';
import type { GameMode, PlayerObservation, PublicPlayerObservation } from './types';

export const ENGINE_REVISION = 'dbe7744b08bea04a67a8e7241c51aa11c4c907fa';

function publicPlayer(player: AiViewSnapshot['players'][number]): PublicPlayerObservation {
  return {
    seat: player.index,
    name: player.name,
    character: player.character,
    health: player.health,
    max_health: player.maxHealth,
    alive: player.alive,
    hand_count: player.handCount,
    equipment_slots: (Object.keys(player.equipment ?? {}) as EquipSlot[]).filter((slot) => !!player.equipment[slot]),
    skills: [...player.skills],
    marks: player.marks.map(({ id, scope }) => ({ id, scope })),
    ...(player.faction ? { faction: player.faction } : {}),
    ...(player.identity ? { identity: player.identity } : {}),
  };
}

/**
 * Convert the viewer-scoped MCP snapshot to the only observation shape allowed to reach a model.
 * Deliberately ignores log, pending.atom, cardMap, event payloads and all opponent hand fields.
 */
export function buildPlayerObservation(
  snapshot: AiViewSnapshot,
  gameMode: GameMode,
): PlayerObservation {
  const self = snapshot.players.find((player) => player.index === snapshot.viewer);
  if (!self) throw new Error(`viewer seat ${snapshot.viewer} is missing from the snapshot`);

  const pending = snapshot.pending
    ? {
        target: snapshot.pending.target,
        blocking: snapshot.pending.isBlocking,
        title: snapshot.pending.promptTitle,
        request_type: snapshot.pending.requestType,
        ...(snapshot.pending.candidates
          ? { character_candidates: snapshot.pending.candidates.map(({ name, skills }) => ({ name, skills: [...skills] })) }
          : {}),
        ...(snapshot.pending.playerCandidates
          ? { player_candidates: snapshot.pending.playerCandidates.map(({ index, name }) => ({ seat: index, name })) }
          : {}),
        ...(snapshot.pending.cardSelection
          ? { choose_count: { min: snapshot.pending.cardSelection.min, max: snapshot.pending.cardSelection.max } }
          : {}),
      }
    : null;

  return {
    engine_id: 'wmzy/sanguosha',
    engine_revision: ENGINE_REVISION,
    game_mode: gameMode,
    seat: snapshot.viewer,
    current_player: snapshot.currentPlayerIndex,
    phase: snapshot.phase,
    round: snapshot.turn.round,
    self: {
      ...publicPlayer(self),
      hand: (self.hand ?? []).map(({ name, suit, rank, type }) => ({ name, suit, rank, type })),
    },
    players: snapshot.players.map(publicPlayer),
    pending,
    zones: {
      deck_count: snapshot.zones.deckCount,
      discard_count: snapshot.zones.discardPileCount,
    },
  };
}

export const AGENT_SYSTEM_PROMPT = `你正在参与 wmzy/sanguosha 模拟引擎中的一局三国杀。你的目标是按照自己的胜利条件提高获胜概率。你只能使用本次输入中提供的 observation 和 legal_actions；不要推测其他玩家的隐藏手牌或身份，不要虚构信息。每个 legal_action 都是已经具体化的候选动作。只返回一个 JSON 对象：{"action_id":"候选动作的 action_id"}。不要附加解释、Markdown 或其他字段。`;
