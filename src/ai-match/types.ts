import type { ClientMessage } from '../engine/types';

export type GameMode = '身份局' | '1v1';

export interface PublicPlayerObservation {
  seat: number;
  name: string;
  character: string;
  health: number;
  max_health: number;
  alive: boolean;
  hand_count: number;
  equipment_slots: string[];
  skills: string[];
  marks: Array<{ id: string; scope: number }>;
  faction?: string;
  identity?: string;
}

export interface PlayerObservation {
  engine_id: 'wmzy/sanguosha';
  engine_revision: string;
  game_mode: GameMode;
  seat: number;
  current_player: number;
  phase: string;
  round: number;
  self: PublicPlayerObservation & {
    hand: Array<{ name: string; suit: string; rank: string; type: string }>;
  };
  players: PublicPlayerObservation[];
  pending: null | {
    target: number;
    blocking: boolean;
    title: string;
    request_type: string;
    character_candidates?: Array<{ name: string; skills: string[] }>;
    player_candidates?: Array<{ seat: number; name: string }>;
    choose_count?: { min: number; max: number };
  };
  zones: { deck_count: number; discard_count: number };
}

/** The engine payload remains private to the match runner and never goes to a provider. */
export interface LegalAction {
  action_id: string;
  type: string;
  description: string;
  target_seat?: number;
  message: ClientMessage;
}

export type PublicLegalAction = Omit<LegalAction, 'message'>;

export interface ModelEndpointConfig {
  provider: 'openai_compatible';
  base_url: string;
  model: string;
  api_key: string;
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
}

export interface MatchConfig {
  server: {
    base_url: string;
    auto_start: boolean;
    port: number;
    startup_timeout_ms: number;
  };
  game: {
    mode: GameMode;
    seed: number;
    timeout_sec: number;
    char_pool: 'standard' | 'extended' | 'all';
    hand_size: number;
  };
  run: {
    games: 1;
    max_retries: number;
    max_decisions: number;
    output_dir: string;
    fallback: 'first';
  };
  players: {
    a: ModelEndpointConfig;
    b: ModelEndpointConfig;
  };
}

export interface ProviderRequest {
  seat: 'a' | 'b';
  observation: PlayerObservation;
  legal_actions: PublicLegalAction[];
  recent_private_history: Array<{ phase: string; action: string }>;
  retry_error?: string;
}

export interface ProviderResponse {
  raw_text: string;
  request_body: Record<string, unknown>;
  latency_ms: number;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface ModelProvider {
  readonly model: string;
  chooseAction(request: ProviderRequest): Promise<ProviderResponse>;
}
