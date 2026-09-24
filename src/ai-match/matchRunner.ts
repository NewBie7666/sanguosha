import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildLegalActionsWithCoverage, chooseDeterministicFallback, parseActionId, resolveActionId, toPublicLegalActions } from './legalActions';
import { McpProcess } from './mcpProcess';
import { buildPlayerObservation } from './observation';
import { getUsageTotals, OpenAICompatibleProvider } from './provider';
import { redactConfig } from './config';
import type {
  LegalAction,
  LegalActionCoverage,
  MatchConfig,
  ModelProvider,
  PlayerObservation,
  ProviderRequest,
  ProviderResponse,
  PublicHistoryEntry,
} from './types';
import type { AiViewSnapshot, AvailableAction } from '../client/headless/types';

type Seat = 'a' | 'b';

interface PlayTelemetry {
  actionSubmitMs: number;
  engineSettlementMs: number;
  silentPendingWaitCount: number;
  silentPendingWaitMs: number;
  otherWaitTimeoutCount: number;
  otherWaitTimeoutMs: number;
}

interface PlayResult {
  roomId: string | null;
  phase: 'lobby' | 'playing' | 'ended';
  gameOver: { winner: string } | null;
  needsAction: boolean;
  turn: number | null;
  currentPlayerIndex: number | null;
  availableActions: AvailableAction[];
  recommendedAction: AvailableAction | null;
  lastActionResult: 'accepted' | 'rejected' | 'timeout' | 'not-applicable';
  lastActionRejectionReason: string | null;
  telemetry?: PlayTelemetry;
}

interface DecisionTiming {
  wait_for_decision_ms: number;
  snapshot_ms: number;
  rule_context_ms: number;
  model_request_ms: number;
  action_submit_ms: number;
  engine_settlement_ms: number;
}

interface WaitDiagnostics {
  silent_pending_wait_count: number;
  silent_pending_wait_ms: number;
  other_wait_timeout_count: number;
  other_wait_timeout_ms: number;
}

type TimingKey = keyof DecisionTiming;


type AttemptErrorKind = 'model_request' | 'model_parse' | 'invalid_action_id';

interface LoggedAttempt {
  request?: Record<string, unknown>;
  raw?: string;
  response?: ProviderResponse;
  error?: string;
  errorKind?: AttemptErrorKind;
  actionId?: string;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function compactTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function probeServer(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/rooms`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startServer(config: MatchConfig, cwd: string): Promise<{ child: ChildProcess | null; reused: boolean }> {
  if (await probeServer(config.server.base_url)) return { child: null, reused: true };
  if (!config.server.auto_start) throw new Error(`game server is not reachable at ${config.server.base_url}`);

  const entry = path.resolve(cwd, 'src/server/index.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd,
    env: { ...process.env, PORT: String(config.server.port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-6000); });
  const startedAt = Date.now();
  while (Date.now() - startedAt < config.server.startup_timeout_ms) {
    if (child.exitCode !== null) throw new Error(`game server exited early (${child.exitCode}): ${stderr}`);
    if (await probeServer(config.server.base_url)) return { child, reused: false };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error(`game server did not become ready at ${config.server.base_url}: ${stderr}`);
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (child?.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2500)),
  ]);
}

interface DecisionSnapshot {
  view: AiViewSnapshot;
  availableActions: AvailableAction[];
}

async function snapshotFor(client: McpProcess): Promise<DecisionSnapshot> {
  const result = await client.callTool<{
    view: AiViewSnapshot | null;
    availableActions?: AvailableAction[];
  }>('getSnapshot', {});
  if (!result.view) throw new Error('MCP snapshot is empty before the decision window');
  return {
    view: result.view,
    availableActions: result.availableActions ?? [],
  };
}

function snapshotNeedsDecision(snapshot: AiViewSnapshot): boolean {
  const pending = snapshot.pending;
  if (!pending) return false;
  if (pending.target < 0) return true;
  if (pending.target !== snapshot.viewer || pending.responseMode === 'silent') return false;
  if (pending.isBlocking) return true;
  return snapshot.phase === '出牌';
}

function asPlayResult(value: unknown): PlayResult {
  if (!value || typeof value !== 'object') throw new Error('MCP play returned an invalid result');
  return value as PlayResult;
}

function latencyOf(attempts: LoggedAttempt[]): number {
  return attempts.reduce((total, attempt) => total + (attempt.response?.latency_ms ?? 0), 0);
}

function attemptUsage(attempts: LoggedAttempt[]): ProviderResponse[] {
  return attempts.flatMap((attempt) => attempt.response ? [attempt.response] : []);
}

function collectRelevantRuleNames(observation: PlayerObservation, actions: LegalAction[]): string[] {
  const names = new Set<string>();
  for (const player of observation.players) {
    for (const skill of player.skills) if (skill.trim()) names.add(skill.trim());
  }
  for (const card of observation.self.hand) if (card.name.trim()) names.add(card.name.trim());
  for (const action of actions) {
    for (const match of action.description.matchAll(/【([^】]+)】/g)) {
      const name = match[1]?.trim();
      if (name) names.add(name);
    }
  }
  return [...names].slice(0, 32);
}

async function buildRelevantRules(
  client: McpProcess,
  observation: PlayerObservation,
  actions: LegalAction[],
  cache: Map<string, string | null>,
): Promise<Record<string, string>> {
  const names = collectRelevantRuleNames(observation, actions);
  const missing = names.filter((name) => !cache.has(name));
  if (missing.length > 0) {
    const result = await client.callTool<{ skills: Array<{ name: string; description: string | null }> }>(
      'getSkillInfo',
      { names: missing },
    );
    for (const item of result.skills) cache.set(item.name, item.description);
    for (const name of missing) if (!cache.has(name)) cache.set(name, null);
  }
  return Object.fromEntries(
    names.flatMap((name) => {
      const description = cache.get(name);
      return description ? [[name, description] as const] : [];
    }),
  );
}

function publishableHistoryAction(action: LegalAction): boolean {
  // Character choice can be hidden until reveal; never share it cross-seat from the runner.
  return action.category !== 'selectChar';
}

type LegalActionCoverageTotals = Omit<LegalActionCoverage, 'coverage_ratio'>;

function sumCoverage(events: Array<Record<string, unknown>>): LegalActionCoverage {
  const totals = events.reduce<LegalActionCoverageTotals>(
    (acc, event) => {
      const coverage = event['legal_action_coverage'] as LegalActionCoverage | undefined;
      if (!coverage) return acc;
      acc.total_templates += coverage.total_templates;
      acc.supported_templates += coverage.supported_templates;
      acc.unsupported_templates += coverage.unsupported_templates;
      acc.concrete_actions += coverage.concrete_actions;
      return acc;
    },
    {
      total_templates: 0,
      supported_templates: 0,
      unsupported_templates: 0,
      concrete_actions: 0,
    },
  );
  return {
    ...totals,
    coverage_ratio: totals.total_templates === 0 ? 1 : totals.supported_templates / totals.total_templates,
  };
}

function countAttemptErrors(events: Array<Record<string, unknown>>, kind: AttemptErrorKind): number {
  return events.reduce((total, event) => {
    const kinds = event['model_error_kinds'];
    return total + (Array.isArray(kinds) ? kinds.filter((value) => value === kind).length : 0);
  }, 0);
}

function emptyDecisionTiming(): DecisionTiming {
  return {
    wait_for_decision_ms: 0,
    snapshot_ms: 0,
    rule_context_ms: 0,
    model_request_ms: 0,
    action_submit_ms: 0,
    engine_settlement_ms: 0,
  };
}

function roundedTiming(timing: DecisionTiming): DecisionTiming {
  return Object.fromEntries(
    Object.entries(timing).map(([key, value]) => [key, Math.round(value)]),
  ) as unknown as DecisionTiming;
}

function emptyWaitDiagnostics(): WaitDiagnostics {
  return {
    silent_pending_wait_count: 0,
    silent_pending_wait_ms: 0,
    other_wait_timeout_count: 0,
    other_wait_timeout_ms: 0,
  };
}

function addWaitDiagnostics(target: WaitDiagnostics, telemetry?: PlayTelemetry): void {
  if (!telemetry) return;
  target.silent_pending_wait_count += telemetry.silentPendingWaitCount;
  target.silent_pending_wait_ms += telemetry.silentPendingWaitMs;
  target.other_wait_timeout_count += telemetry.otherWaitTimeoutCount;
  target.other_wait_timeout_ms += telemetry.otherWaitTimeoutMs;
}

function sumTiming(events: Array<Record<string, unknown>>, key: TimingKey): number {
  return Math.round(events.reduce((sum, event) => {
    const timing = event['timing_ms'] as Partial<DecisionTiming> | undefined;
    return sum + Number(timing?.[key] ?? 0);
  }, 0));
}

function averageTiming(events: Array<Record<string, unknown>>, key: TimingKey): number {
  return events.length === 0 ? 0 : Math.round(sumTiming(events, key) / events.length);
}

function rejectionReasonCounts(events: Array<Record<string, unknown>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const reasons = event['engine_rejection_reasons'];
    if (!Array.isArray(reasons)) continue;
    for (const reason of reasons) {
      if (typeof reason !== 'string') continue;
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
  }
  return counts;
}

function makeSummaryMarkdown(summary: Record<string, unknown>): string {
  const tokens = summary['tokens'] as { a?: number; b?: number } | undefined;
  const perf = summary['performance_ms'] as {
    total?: Partial<DecisionTiming>;
    average_per_decision?: Partial<DecisionTiming>;
  } | undefined;
  const waits = summary['wait_diagnostics'] as Partial<WaitDiagnostics> | undefined;
  return [
    '# 对局战报',
    '',
    `- 状态：${summary['status']}`,
    `- 规则引擎：${summary['engine_id']} @ ${summary['engine_revision']}`,
    `- 模式 / seed：${summary['game_mode']} / ${summary['seed']}`,
    `- 胜者：${summary['winner'] ?? '未决'}${summary['winner_player'] ? `（${summary['winner_player']}）` : ''}`,
    `- 败者：${summary['loser_player'] ?? '未决'}`,
    `- 房间：${summary['room_id'] ?? '未创建'}`,
    `- 用时：${summary['duration_ms']} ms`,
    `- 决策步数：${summary['decision_steps']}`,
    `- 最终回合：${summary['total_turns']}`,
    `- 模型：A=${summary['models'] && (summary['models'] as Record<string, unknown>)['a']}；B=${summary['models'] && (summary['models'] as Record<string, unknown>)['b']}`,
    `- Token：A=${tokens?.a ?? 0}；B=${tokens?.b ?? 0}`,
    `- 平均模型延迟：${summary['average_latency_ms']} ms`,
    `- 模型错误：parse=${summary['model_parse_errors']}；invalid_action_id=${summary['model_invalid_action_ids']}；request=${summary['model_request_errors']}`,
    `- stale window：${summary['stale_windows']}；引擎拒绝：${summary['engine_rejections']}；fallback：${summary['fallback_actions']}`,
    `- 可训练决策：${summary['training_eligible_steps']} / ${summary['decision_steps']}`,
    `- LegalAction 模板覆盖率：${((summary['legal_action_coverage'] as LegalActionCoverage | undefined)?.coverage_ratio ?? 0) * 100}%`,
    '',
    '## 性能诊断',
    `- 累计耗时(ms)：wait=${perf?.total?.wait_for_decision_ms ?? 0}；snapshot=${perf?.total?.snapshot_ms ?? 0}；rules=${perf?.total?.rule_context_ms ?? 0}；model=${perf?.total?.model_request_ms ?? 0}；submit=${perf?.total?.action_submit_ms ?? 0}；settlement=${perf?.total?.engine_settlement_ms ?? 0}`,
    `- 每决策平均(ms)：wait=${perf?.average_per_decision?.wait_for_decision_ms ?? 0}；snapshot=${perf?.average_per_decision?.snapshot_ms ?? 0}；rules=${perf?.average_per_decision?.rule_context_ms ?? 0}；model=${perf?.average_per_decision?.model_request_ms ?? 0}；submit=${perf?.average_per_decision?.action_submit_ms ?? 0}；settlement=${perf?.average_per_decision?.engine_settlement_ms ?? 0}`,
    `- silent pending：${waits?.silent_pending_wait_count ?? 0} 次 / ${waits?.silent_pending_wait_ms ?? 0} ms`,
    `- 其他显式等待超时：${waits?.other_wait_timeout_count ?? 0} 次 / ${waits?.other_wait_timeout_ms ?? 0} ms`,
    ...(typeof summary['error'] === 'string' ? ['', `错误：${summary['error']}`] : []),
    '',
  ].join('\n');
}

export interface MatchDependencies {
  providers?: Partial<Record<Seat, ModelProvider>>;
  cwd?: string;
  onProgress?: (message: string) => void;
}

export async function runMatch(config: MatchConfig, dependencies: MatchDependencies = {}): Promise<Record<string, unknown>> {
  if (config.run.games !== 1) throw new Error('Phase 1 supports one game per run');
  const cwd = dependencies.cwd ?? process.cwd();
  const createdAt = new Date();
  const runId = `${compactTimestamp(createdAt)}_game001`;
  const runDir = path.join(config.run.output_dir, runId);
  await mkdir(runDir, { recursive: false });
  await writeFile(path.join(runDir, 'config.json'), `${json(redactConfig(config))}\n`, 'utf8');
  const gameLogPath = path.join(runDir, 'game.jsonl');
  await writeFile(gameLogPath, '', 'utf8');

  const providers: Record<Seat, ModelProvider> = {
    a: dependencies.providers?.a ?? new OpenAICompatibleProvider(config.players.a),
    b: dependencies.providers?.b ?? new OpenAICompatibleProvider(config.players.b),
  };
  const privateHistory: Record<Seat, Array<{ phase: string; action: string }>> = { a: [], b: [] };
  const publicHistory: PublicHistoryEntry[] = [];
  const ruleCache = new Map<string, string | null>();
  const mcp: Partial<Record<Seat, McpProcess>> = {};
  let serverChild: ChildProcess | null = null;
  const events: Array<Record<string, unknown>> = [];
  const seatIndexes: Partial<Record<Seat, number>> = {};
  const startedAt = Date.now();
  let roomId: string | null = null;
  let winner: string | null = null;
  let completionStatus: 'completed' | 'incomplete' = 'incomplete';
  let failure: string | undefined;
  let schedulerWaitWallMs = 0;
  const pendingDecisionWaitMs: Record<Seat, number> = { a: 0, b: 0 };
  const pendingWaitDiagnostics: Record<Seat, WaitDiagnostics> = {
    a: emptyWaitDiagnostics(),
    b: emptyWaitDiagnostics(),
  };
  const totalWaitDiagnostics = emptyWaitDiagnostics();

  const writeEvent = async (event: Record<string, unknown>) => {
    events.push(event);
    await appendFile(gameLogPath, `${JSON.stringify(event)}\n`, 'utf8');
  };

  try {
    const server = await startServer(config, cwd);
    serverChild = server.child;
    dependencies.onProgress?.(server.reused ? `复用游戏服务 ${config.server.base_url}` : `游戏服务已启动 ${config.server.base_url}`);

    mcp.a = McpProcess.start(config.server.base_url, 0, cwd);
    mcp.b = McpProcess.start(config.server.base_url, 1, cwd);
    await Promise.all([mcp.a.initialize(), mcp.b.initialize()]);
    const room = await mcp.a.callTool<{ roomId: string | null }>('createRoom', {
      name: `LLM-${config.game.seed}`,
      maxPlayers: 2,
      timeoutSec: config.game.timeout_sec,
      gameMode: config.game.mode,
      seed: config.game.seed,
      charPool: config.game.char_pool,
      handSize: config.game.hand_size,
    });
    if (!room.roomId) throw new Error('MCP host did not return a room id');
    roomId = room.roomId;
    await mcp.b.callTool('joinRoom', { roomId });
    dependencies.onProgress?.(`两个独立 Agent 已进入房间 ${roomId}`);

    type ScheduledPlay = { seat: Seat; result: PlayResult; source: 'wait' | 'carried' };
    const queueWait = (seat: Seat): Promise<ScheduledPlay> =>
      mcp[seat]!.callTool('play', {}).then(asPlayResult).then((result) => ({ seat, result, source: 'wait' as const }));
    const carryResult = (seat: Seat, result: PlayResult): Promise<ScheduledPlay> =>
      Promise.resolve({ seat, result, source: 'carried' as const });
    const pendingA = queueWait('a');
    const pendingB = queueWait('b');
    const inFlight: Record<Seat, Promise<ScheduledPlay> | null> = { a: pendingA, b: pendingB };

    while (events.length < config.run.max_decisions) {
      const active = Object.values(inFlight).filter((promise): promise is Promise<ScheduledPlay> => !!promise);
      if (active.length === 0) throw new Error('both MCP seats stopped waiting without a game result');
      const schedulerWaitStartedAt = performance.now();
      const arrived = await Promise.race(active);
      const schedulerWaitMs = performance.now() - schedulerWaitStartedAt;
      schedulerWaitWallMs += schedulerWaitMs;
      pendingDecisionWaitMs[arrived.seat] += schedulerWaitMs;
      if (arrived.source === 'wait') {
        addWaitDiagnostics(pendingWaitDiagnostics[arrived.seat], arrived.result.telemetry);
        addWaitDiagnostics(totalWaitDiagnostics, arrived.result.telemetry);
      }
      inFlight[arrived.seat] = null;
      const initialResult = arrived.result;
      if (initialResult.gameOver) {
        winner = initialResult.gameOver.winner;
        completionStatus = 'completed';
        // The other seat's blocking play() may be the first call to observe the
        // gameOver event. Attach that result to the last submitted action row.
        const finalAction = events.at(-1);
        if (finalAction && !finalAction['game_result_after_action']) {
          finalAction['game_result_after_action'] = initialResult.gameOver;
          await writeFile(gameLogPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
        }
        break;
      }
      if (!initialResult.needsAction) {
        inFlight[arrived.seat] = queueWait(arrived.seat);
        continue;
      }

      const client = mcp[arrived.seat]!;
      const timing = emptyDecisionTiming();
      timing.wait_for_decision_ms = pendingDecisionWaitMs[arrived.seat];
      const decisionWaitDiagnostics = { ...pendingWaitDiagnostics[arrived.seat] };
      const timedSnapshot = async (): Promise<DecisionSnapshot> => {
        const started = performance.now();
        try {
          return await snapshotFor(client);
        } finally {
          timing.snapshot_ms += performance.now() - started;
        }
      };
      let currentResult = initialResult;
      let decisionSnapshot = await timedSnapshot();
      let currentSnapshot = decisionSnapshot.view;
      let currentAvailableActions = decisionSnapshot.availableActions;
      // A second MCP seat can advance the room between this play() response and
      // getSnapshot(). Never send a stale prompt to the model or submit an action
      // against a pending window now owned by the opponent.
      if (!snapshotNeedsDecision(currentSnapshot)) {
        inFlight[arrived.seat] = queueWait(arrived.seat);
        continue;
      }
      let latestObservation = buildPlayerObservation(currentSnapshot, config.game.mode);
      seatIndexes[arrived.seat] = latestObservation.seat;
      let actionBuild = buildLegalActionsWithCoverage(currentAvailableActions, currentSnapshot);
      let latestActions = actionBuild.actions;
      let latestCoverage = actionBuild.coverage;
      const attempts: LoggedAttempt[] = [];
      const errors: string[] = [];
      let chosen: LegalAction | null = null;
      let modelActionValid = false;
      let fallbackReason: string | undefined;
      let engineRejections = 0;
      const engineRejectionReasons: string[] = [];
      let staleWindow = false;
      let lastSubmittedAction: LegalAction | null = null;

      for (let retry = 0; retry <= config.run.max_retries; retry++) {
        if (latestActions.length === 0) {
          const window = currentSnapshot.pending
            ? {
                title: currentSnapshot.pending.promptTitle,
                request_type: currentSnapshot.pending.requestType,
                viewer: currentSnapshot.viewer,
                target: currentSnapshot.pending.target,
                blocking: currentSnapshot.pending.isBlocking,
                mandatory: currentSnapshot.pending.mandatory,
                response_mode: currentSnapshot.pending.responseMode,
              }
            : null;
          const templates = currentAvailableActions.map(({ category, description, message }) => ({
            category,
            description,
            action_type: message.actionType,
            skill: message.skillId,
          }));
          errors.push(`没有可安全具体化的合法动作；窗口=${JSON.stringify(window)}；模板=${JSON.stringify(templates)}`);
          break;
        }
        const ruleStartedAt = performance.now();
        const relevantRules = await buildRelevantRules(client, latestObservation, latestActions, ruleCache);
        timing.rule_context_ms += performance.now() - ruleStartedAt;
        const providerRequest: ProviderRequest = {
          seat: arrived.seat,
          observation: latestObservation,
          legal_actions: toPublicLegalActions(latestActions),
          recent_public_history: publicHistory.slice(-24),
          recent_private_history: privateHistory[arrived.seat].slice(-12),
          relevant_rules: relevantRules,
          ...(errors.length ? { retry_error: errors[errors.length - 1] } : {}),
        };
        let attempt: LoggedAttempt = {
          request: { model: providers[arrived.seat].model, input: providerRequest },
        };
        const modelStartedAt = performance.now();
        try {
          const response = await providers[arrived.seat].chooseAction(providerRequest);
          attempt.request = response.request_body;
          attempt.raw = response.raw_text;
          attempt.response = response;
          let actionId: string | null = null;
          try {
            actionId = parseActionId(response.raw_text);
            attempt.actionId = actionId;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(message);
            attempt.error = message;
            attempt.errorKind = 'model_parse';
          }
          if (actionId) {
            try {
              chosen = resolveActionId(actionId, latestActions);
              modelActionValid = true;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              errors.push(message);
              attempt.error = message;
              attempt.errorKind = 'invalid_action_id';
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(message);
          attempt = { error: message, errorKind: 'model_request' };
        } finally {
          timing.model_request_ms += performance.now() - modelStartedAt;
        }
        attempts.push(attempt);
        if (!chosen) continue;

        // Revalidate after model latency. The opponent/timers can advance a pending
        // window while the model is thinking. Only submit if both the safe
        // observation and public legal-action set are still identical.
        decisionSnapshot = await timedSnapshot();
        currentSnapshot = decisionSnapshot.view;
        currentAvailableActions = decisionSnapshot.availableActions;
        if (!snapshotNeedsDecision(currentSnapshot)) {
          staleWindow = true;
          break;
        }
        const refreshedObservation = buildPlayerObservation(currentSnapshot, config.game.mode);
        const refreshedBuild = buildLegalActionsWithCoverage(currentAvailableActions, currentSnapshot);
        const refreshedActions = refreshedBuild.actions;
        const sameObservation = JSON.stringify(refreshedObservation) === JSON.stringify(latestObservation);
        const sameActions = JSON.stringify(toPublicLegalActions(refreshedActions))
          === JSON.stringify(toPublicLegalActions(latestActions));
        if (!sameObservation || !sameActions) {
          errors.push('模型思考期间决策窗口已变化；已刷新 observation 和 legal_actions，请重新选择');
          chosen = null;
          latestObservation = refreshedObservation;
          latestActions = refreshedActions;
          latestCoverage = refreshedBuild.coverage;
          continue;
        }
        const chosenMessage = JSON.stringify(chosen.message);
        const refreshedChosen = refreshedActions.find((action) => JSON.stringify(action.message) === chosenMessage);
        if (!refreshedChosen) {
          errors.push('模型选择的动作在提交前已不再合法；已刷新 legal_actions，请重新选择');
          chosen = null;
          latestObservation = refreshedObservation;
          latestActions = refreshedActions;
          latestCoverage = refreshedBuild.coverage;
          continue;
        }
        chosen = refreshedChosen;
        latestObservation = refreshedObservation;
        latestActions = refreshedActions;
        latestCoverage = refreshedBuild.coverage;

        lastSubmittedAction = chosen;
        const actionCallStartedAt = performance.now();
        const submitted = await client.callTool('play', {
          action: chosen.message,
          returnAfterAction: true,
        });
        const actionCallMs = performance.now() - actionCallStartedAt;
        currentResult = asPlayResult(submitted);
        const engineSettlementMs = currentResult.telemetry?.engineSettlementMs ?? 0;
        timing.engine_settlement_ms += engineSettlementMs;
        timing.action_submit_ms += Math.max(
          currentResult.telemetry?.actionSubmitMs ?? 0,
          actionCallMs - engineSettlementMs,
        );
        addWaitDiagnostics(decisionWaitDiagnostics, currentResult.telemetry);
        addWaitDiagnostics(totalWaitDiagnostics, currentResult.telemetry);
        if (currentResult.lastActionResult === 'rejected') {
          engineRejections++;
          engineRejectionReasons.push(currentResult.lastActionRejectionReason ?? 'unknown');
          errors.push(`游戏引擎拒绝了本次动作(${currentResult.lastActionRejectionReason ?? 'unknown'})；请基于新的 observation 和 legal_actions 重选`);
          chosen = null;
          decisionSnapshot = await timedSnapshot();
          currentSnapshot = decisionSnapshot.view;
          currentAvailableActions = decisionSnapshot.availableActions;
          if (!snapshotNeedsDecision(currentSnapshot)) {
            staleWindow = true;
            break;
          }
          latestObservation = buildPlayerObservation(currentSnapshot, config.game.mode);
          actionBuild = buildLegalActionsWithCoverage(currentAvailableActions, currentSnapshot);
          latestActions = actionBuild.actions;
          latestCoverage = actionBuild.coverage;
          continue;
        }
        break;
      }

      if (staleWindow) {
        const decisionStep = events.length + 1;
        const totalTokens = getUsageTotals(attemptUsage(attempts));
        await writeEvent({
          step: decisionStep,
          turn: latestObservation.round,
          player: arrived.seat,
          player_observation: latestObservation,
          legal_actions: toPublicLegalActions(latestActions),
          legal_action_coverage: latestCoverage,
          model_request: attempts.map((attempt) => attempt.request ?? null),
          model_raw_response: attempts.map((attempt) => attempt.raw ?? null),
          parsed_action: lastSubmittedAction
            ? { action_id: lastSubmittedAction.action_id, description: lastSubmittedAction.description }
            : null,
          action_valid: false,
          model_action_valid: modelActionValid,
          retry_count: Math.max(0, attempts.length - 1),
          engine_rejections: engineRejections,
          engine_rejection_reasons: engineRejectionReasons,
          fallback: false,
          stale_window: true,
          training_eligible: false,
          action_result: 'stale_window',
          game_result_after_action: null,
          latency_ms: latencyOf(attempts),
          timing_ms: roundedTiming(timing),
          wait_diagnostics: decisionWaitDiagnostics,
          tokens: totalTokens,
          model_errors: attempts.flatMap((attempt) => attempt.error ? [attempt.error] : []),
          model_error_kinds: attempts.flatMap((attempt) => attempt.errorKind ? [attempt.errorKind] : []),
          scheduler_errors: ['提交前决策窗口已切换；丢弃过期动作并重新等待'],
        });
        pendingDecisionWaitMs[arrived.seat] = 0;
        pendingWaitDiagnostics[arrived.seat] = emptyWaitDiagnostics();
        inFlight[arrived.seat] = queueWait(arrived.seat);
        continue;
      }

      if (!chosen || currentResult.lastActionResult === 'rejected' || currentResult.lastActionResult === 'not-applicable') {
        fallbackReason = errors.at(-1) ?? '模型未选择有效动作';
        const alreadyTried = new Set(attempts.map((attempt) => attempt.actionId).filter((id): id is string => !!id));
        const fallbacks = [chooseDeterministicFallback(latestActions), ...latestActions]
          .filter((action): action is LegalAction => !!action && !alreadyTried.has(action.action_id));
        for (const fallback of fallbacks) {
          chosen = fallback;
          modelActionValid = false;
          const actionCallStartedAt = performance.now();
          const submitted = await client.callTool('play', {
            action: fallback.message,
            returnAfterAction: true,
          });
          const actionCallMs = performance.now() - actionCallStartedAt;
          currentResult = asPlayResult(submitted);
          const engineSettlementMs = currentResult.telemetry?.engineSettlementMs ?? 0;
          timing.engine_settlement_ms += engineSettlementMs;
          timing.action_submit_ms += Math.max(
            currentResult.telemetry?.actionSubmitMs ?? 0,
            actionCallMs - engineSettlementMs,
          );
          addWaitDiagnostics(decisionWaitDiagnostics, currentResult.telemetry);
          addWaitDiagnostics(totalWaitDiagnostics, currentResult.telemetry);
          if (currentResult.lastActionResult !== 'rejected') break;
          engineRejections++;
          engineRejectionReasons.push(currentResult.lastActionRejectionReason ?? 'unknown');
          alreadyTried.add(fallback.action_id);
          chosen = null;
          decisionSnapshot = await timedSnapshot();
          currentSnapshot = decisionSnapshot.view;
          currentAvailableActions = decisionSnapshot.availableActions;
          latestObservation = buildPlayerObservation(currentSnapshot, config.game.mode);
          actionBuild = buildLegalActionsWithCoverage(currentAvailableActions, currentSnapshot);
          latestActions = actionBuild.actions;
          latestCoverage = actionBuild.coverage;
        }
        if (!chosen) throw new Error(`模型重试和确定性兜底均无法提交动作: ${fallbackReason}`);
      }

      const decisionStep = events.length + 1;
      const totalTokens = getUsageTotals(attemptUsage(attempts));
      const event: Record<string, unknown> = {
        step: decisionStep,
        turn: latestObservation.round,
        player: arrived.seat,
        player_observation: latestObservation,
        legal_actions: toPublicLegalActions(latestActions),
        legal_action_coverage: latestCoverage,
        model_request: attempts.map((attempt) => attempt.request ?? null),
        model_raw_response: attempts.map((attempt) => attempt.raw ?? null),
        parsed_action: { action_id: chosen.action_id, description: chosen.description },
        action_valid: true,
        model_action_valid: modelActionValid,
        retry_count: attempts.length > 0 ? attempts.length - 1 : 0,
        engine_rejections: engineRejections,
        engine_rejection_reasons: engineRejectionReasons,
        fallback: !modelActionValid,
        stale_window: false,
        training_eligible: modelActionValid && engineRejections === 0 && currentResult.lastActionResult === 'accepted',
        ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
        unsupported_action_count: latestCoverage.unsupported_templates,
        action_result: currentResult.lastActionResult,
        game_result_after_action: currentResult.gameOver,
        latency_ms: latencyOf(attempts),
        timing_ms: roundedTiming(timing),
        wait_diagnostics: decisionWaitDiagnostics,
        tokens: totalTokens,
        model_errors: attempts.flatMap((attempt) => attempt.error ? [attempt.error] : []),
        model_error_kinds: attempts.flatMap((attempt) => attempt.errorKind ? [attempt.errorKind] : []),
      };
      await writeEvent(event);
      pendingDecisionWaitMs[arrived.seat] = 0;
      pendingWaitDiagnostics[arrived.seat] = emptyWaitDiagnostics();
      privateHistory[arrived.seat].push({ phase: latestObservation.phase, action: chosen.description });
      if (currentResult.lastActionResult === 'accepted' && publishableHistoryAction(chosen)) {
        publicHistory.push({
          round: latestObservation.round,
          phase: latestObservation.phase,
          actor: arrived.seat,
          actor_seat: latestObservation.seat,
          action: chosen.description,
        });
      }
      dependencies.onProgress?.(`决策 ${decisionStep}: ${arrived.seat} · ${chosen.description}`);

      if (currentResult.gameOver) {
        winner = currentResult.gameOver.winner;
        completionStatus = 'completed';
        break;
      }
      inFlight[arrived.seat] = carryResult(arrived.seat, currentResult);
    }

    if (completionStatus !== 'completed') {
      throw new Error(`decision limit reached (${config.run.max_decisions}) before game end`);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    await Promise.all(Object.values(mcp).map((client) => client?.close().catch(() => undefined)));
    await stopChild(serverChild);
  }

  const finishedAt = Date.now();
  const durationMs = finishedAt - startedAt;
  const winnerPlayer = winner === null
    ? null
    : (Object.entries(seatIndexes).find(([, seatIndex]) => String(seatIndex) === winner)?.[0] as Seat | undefined) ?? null;
  const loserPlayer: Seat | null = winnerPlayer === 'a' ? 'b' : winnerPlayer === 'b' ? 'a' : null;
  const tokenA = events.reduce((sum, event) => sum + Number((event['tokens'] as { total_tokens?: number } | undefined)?.total_tokens ?? 0) * (event['player'] === 'a' ? 1 : 0), 0);
  const tokenB = events.reduce((sum, event) => sum + Number((event['tokens'] as { total_tokens?: number } | undefined)?.total_tokens ?? 0) * (event['player'] === 'b' ? 1 : 0), 0);
  const latencyTotal = events.reduce((sum, event) => sum + Number(event['latency_ms'] ?? 0), 0);
  const latencyByPlayer = (seat: Seat) => {
    const playerEvents = events.filter((event) => event['player'] === seat);
    return playerEvents.length
      ? Math.round(playerEvents.reduce((sum, event) => sum + Number(event['latency_ms'] ?? 0), 0) / playerEvents.length)
      : 0;
  };
  const coverage = sumCoverage(events);
  const trainingEligibleSteps = events.filter((event) => event['training_eligible'] === true).length;
  const modelParseErrors = countAttemptErrors(events, 'model_parse');
  const modelInvalidActionIds = countAttemptErrors(events, 'invalid_action_id');
  const modelRequestErrors = countAttemptErrors(events, 'model_request');
  const staleWindows = events.filter((event) => event['stale_window'] === true).length;
  const engineRejectionReasons = rejectionReasonCounts(events);
  const performanceTotal: DecisionTiming = {
    wait_for_decision_ms: Math.round(schedulerWaitWallMs),
    snapshot_ms: sumTiming(events, 'snapshot_ms'),
    rule_context_ms: sumTiming(events, 'rule_context_ms'),
    model_request_ms: sumTiming(events, 'model_request_ms'),
    action_submit_ms: sumTiming(events, 'action_submit_ms'),
    engine_settlement_ms: sumTiming(events, 'engine_settlement_ms'),
  };
  const performanceAverage: DecisionTiming = {
    wait_for_decision_ms: averageTiming(events, 'wait_for_decision_ms'),
    snapshot_ms: averageTiming(events, 'snapshot_ms'),
    rule_context_ms: averageTiming(events, 'rule_context_ms'),
    model_request_ms: averageTiming(events, 'model_request_ms'),
    action_submit_ms: averageTiming(events, 'action_submit_ms'),
    engine_settlement_ms: averageTiming(events, 'engine_settlement_ms'),
  };
  const summary: Record<string, unknown> = {
    status: completionStatus,
    engine_id: 'wmzy/sanguosha',
    engine_revision: 'dbe7744b08bea04a67a8e7241c51aa11c4c907fa',
    game_mode: config.game.mode,
    seed: config.game.seed,
    room_id: roomId,
    winner: winnerPlayer ?? winner,
    winner_player: winnerPlayer,
    loser_player: loserPlayer,
    winner_engine_seat: winner,
    models: { a: providers.a.model, b: providers.b.model },
    started_at: createdAt.toISOString(),
    finished_at: new Date(finishedAt).toISOString(),
    duration_ms: durationMs,
    decision_steps: events.length,
    total_turns: events.reduce((max, event) => Math.max(max, Number(event['turn'] ?? 0)), 0),
    tokens: { a: tokenA, b: tokenB, total: tokenA + tokenB },
    average_latency_ms: events.length ? Math.round(latencyTotal / events.length) : 0,
    average_latency_ms_by_player: { a: latencyByPlayer('a'), b: latencyByPlayer('b') },
    model_parse_errors: modelParseErrors,
    model_invalid_action_ids: modelInvalidActionIds,
    model_request_errors: modelRequestErrors,
    invalid_model_outputs: modelParseErrors + modelInvalidActionIds,
    stale_windows: staleWindows,
    engine_rejections: events.reduce((sum, event) => sum + Number(event['engine_rejections'] ?? 0), 0),
    engine_rejection_reasons: engineRejectionReasons,
    retries: events.reduce((sum, event) => sum + Number(event['retry_count'] ?? 0), 0),
    illegal_actions: events.reduce((sum, event) => sum + Number(event['engine_rejections'] ?? 0), 0),
    fallback_actions: events.filter((event) => event['fallback'] === true).length,
    training_eligible_steps: trainingEligibleSteps,
    training_excluded_steps: events.length - trainingEligibleSteps,
    legal_action_coverage: coverage,
    performance_ms: {
      total: performanceTotal,
      average_per_decision: performanceAverage,
    },
    wait_diagnostics: {
      silent_pending_wait_count: totalWaitDiagnostics.silent_pending_wait_count,
      silent_pending_wait_ms: Math.round(totalWaitDiagnostics.silent_pending_wait_ms),
      other_wait_timeout_count: totalWaitDiagnostics.other_wait_timeout_count,
      other_wait_timeout_ms: Math.round(totalWaitDiagnostics.other_wait_timeout_ms),
    },
    key_actions: events.slice(-10).map((event) => ({ player: event['player'], action: (event['parsed_action'] as { description?: string })?.description })),
    ...(failure ? { error: failure } : {}),
  };
  await writeFile(path.join(runDir, 'summary.json'), `${json(summary)}\n`, 'utf8');
  await writeFile(path.join(runDir, 'summary.md'), makeSummaryMarkdown(summary), 'utf8');
  if (failure) throw new Error(`${failure}\nPartial artifacts saved to ${runDir}`);
  return { ...summary, run_dir: runDir };
}
