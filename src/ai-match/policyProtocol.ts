import type {
  PlayerObservation,
  PublicHistoryEntry,
  PublicLegalAction,
} from './types';

export const POLICY_PROTOCOL_VERSION = '1.0' as const;
export const POLICY_SCHEMA = 'sanguosha-policy' as const;

export type PolicyGameMode =
  | 'identity'
  | 'duel_1v1'
  | 'doudizhu'
  | 'ranked_2v2'
  | 'unknown';

export interface PolicyCardV1 {
  name: string;
  suit?: string;
  rank?: string;
  type?: string;
}

export interface PolicyPlayerV1 {
  seat_id: string;
  relation: 'self' | 'teammate' | 'opponent' | 'unknown';
  name?: string;
  character?: string;
  health?: number;
  max_health?: number;
  alive?: boolean;
  hand_count?: number;
  hand?: PolicyCardV1[];
  equipment_slots?: string[];
  skills?: string[];
  faction?: string;
  identity?: string;
}

export interface PolicyPendingV1 {
  blocking: boolean;
  title: string;
  request_type: string;
  target_seat_id?: string;
  choose_count?: { min: number; max: number };
}

export interface PolicyStateV1 {
  schema: typeof POLICY_SCHEMA;
  schema_version: typeof POLICY_PROTOCOL_VERSION;
  source: 'engine' | 'video' | 'visionbox';
  mode: PolicyGameMode;
  viewer_seat_id: string | null;
  current_player_seat_id: string | null;
  phase: string | null;
  round: number | null;
  self: PolicyPlayerV1 | null;
  players: PolicyPlayerV1[];
  pending: PolicyPendingV1 | null;
  zones?: {
    deck_count?: number;
    discard_count?: number;
  };
  public_history?: Array<{
    round: number;
    phase: string;
    actor_seat_id: string;
    action: string;
  }>;
}

export interface PolicyActionCandidateV1 {
  action_id: string;
  type: string;
  category: string;
  description: string;
  target_seat_ids: string[];
}

export interface PolicyTrainingSampleV1 {
  schema: typeof POLICY_SCHEMA;
  schema_version: typeof POLICY_PROTOCOL_VERSION;
  sample_id: string;
  source: 'engine' | 'video';
  state: PolicyStateV1;
  legal_actions: PolicyActionCandidateV1[];
  chosen_action_id: string | null;
  training_ready: boolean;
  exclusion_reasons: string[];
  metadata?: Record<string, unknown>;
}

export function normalizePolicyMode(mode: string): PolicyGameMode {
  switch (mode) {
    case '身份局':
    case 'identity':
      return 'identity';
    case '1v1':
    case 'duel_1v1':
      return 'duel_1v1';
    case 'doudizhu':
      return 'doudizhu';
    case 'ranked_2v2':
      return 'ranked_2v2';
    default:
      return 'unknown';
  }
}

function relationForSeat(observation: PlayerObservation, seat: number): PolicyPlayerV1['relation'] {
  if (seat === observation.seat) return 'self';
  // The current engine observation does not expose trustworthy team relation for all modes.
  // Preserve uncertainty instead of deriving relation from identity/faction heuristics.
  return 'unknown';
}

function toPolicyPlayer(
  observation: PlayerObservation,
  player: PlayerObservation['players'][number],
): PolicyPlayerV1 {
  const hand = player.seat === observation.seat
    ? observation.self.hand.map(({ name, suit, rank, type }) => ({ name, suit, rank, type }))
    : undefined;
  return {
    seat_id: String(player.seat),
    relation: relationForSeat(observation, player.seat),
    name: player.name,
    character: player.character,
    health: player.health,
    max_health: player.max_health,
    alive: player.alive,
    hand_count: player.hand_count,
    ...(hand ? { hand } : {}),
    equipment_slots: [...player.equipment_slots],
    skills: [...player.skills],
    ...(player.faction ? { faction: player.faction } : {}),
    ...(player.identity ? { identity: player.identity } : {}),
  };
}

export function toPolicyStateV1(
  observation: PlayerObservation,
  publicHistory: PublicHistoryEntry[] = [],
): PolicyStateV1 {
  const players = observation.players.map((player) => toPolicyPlayer(observation, player));
  const self = players.find((player) => player.seat_id === String(observation.seat)) ?? null;
  return {
    schema: POLICY_SCHEMA,
    schema_version: POLICY_PROTOCOL_VERSION,
    source: 'engine',
    mode: normalizePolicyMode(observation.game_mode),
    viewer_seat_id: String(observation.seat),
    current_player_seat_id: String(observation.current_player),
    phase: observation.phase,
    round: observation.round,
    self,
    players,
    pending: observation.pending
      ? {
          blocking: observation.pending.blocking,
          title: observation.pending.title,
          request_type: observation.pending.request_type,
          ...(Number.isInteger(observation.pending.target)
            ? { target_seat_id: String(observation.pending.target) }
            : {}),
          ...(observation.pending.choose_count
            ? { choose_count: { ...observation.pending.choose_count } }
            : {}),
        }
      : null,
    zones: {
      deck_count: observation.zones.deck_count,
      discard_count: observation.zones.discard_count,
    },
    public_history: publicHistory.map((entry) => ({
      round: entry.round,
      phase: entry.phase,
      actor_seat_id: String(entry.actor_seat),
      action: entry.action,
    })),
  };
}

export function toPolicyActionCandidatesV1(
  actions: PublicLegalAction[],
): PolicyActionCandidateV1[] {
  return actions.map((action) => ({
    action_id: action.action_id,
    type: action.type,
    category: action.category,
    description: action.description,
    target_seat_ids: action.target_seat === undefined ? [] : [String(action.target_seat)],
  }));
}

export interface EnginePolicySampleInput {
  sample_id: string;
  observation: PlayerObservation;
  legal_actions: PublicLegalAction[];
  chosen_action_id: string | null;
  training_eligible: boolean;
  public_history?: PublicHistoryEntry[];
  metadata?: Record<string, unknown>;
}

export function buildEnginePolicySampleV1(
  input: EnginePolicySampleInput,
): PolicyTrainingSampleV1 {
  const candidates = toPolicyActionCandidatesV1(input.legal_actions);
  const reasons: string[] = [];
  if (candidates.length === 0) reasons.push('no_legal_actions');
  if (!input.chosen_action_id) {
    reasons.push('missing_chosen_action');
  } else if (!candidates.some((action) => action.action_id === input.chosen_action_id)) {
    reasons.push('chosen_action_not_in_legal_actions');
  }
  if (!input.training_eligible) reasons.push('source_not_training_eligible');

  return {
    schema: POLICY_SCHEMA,
    schema_version: POLICY_PROTOCOL_VERSION,
    sample_id: input.sample_id,
    source: 'engine',
    state: toPolicyStateV1(input.observation, input.public_history),
    legal_actions: candidates,
    chosen_action_id: input.chosen_action_id,
    training_ready: reasons.length === 0,
    exclusion_reasons: reasons,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}
