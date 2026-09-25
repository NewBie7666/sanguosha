import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  askLocalModel,
  buildContext,
  buildDecisionSignature,
  decisionChangeReason,
  normalizeDecisionText,
} from './live-advisor-core.mjs';
import { evaluateFastPolicy } from './live-advisor-fast-policy.mjs';
import { buildSkillHints } from './live-skill-catalog.mjs';

const VISION_URL = process.env.VISIONBOX_URL ?? 'http://127.0.0.1:8765';
const HOST = '127.0.0.1';
const PORT = Number(process.env.LIVE_ADVISOR_PORT ?? 8767);
const MAX_EVENT_AGE_MS = 4000;
const MAX_CAPTURE_AGE_MS = 4000;
const UNSTABLE_GRACE_MS = 600;
const UNSTABLE_GRACE_EVENTS = 3;
const MODEL_ID = 'qwen/qwen3-14b';
const MODEL_LIST_URL = process.env.LIVE_ADVISOR_MODEL_LIST_URL ?? 'http://127.0.0.1:1234/v1/models';

export async function probeLocalModel(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(MODEL_LIST_URL, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { connected: false, reason: `本机模型接口返回 ${response.status}` };
    const payload = await response.json();
    if (!payload.data?.some((item) => item.id === MODEL_ID)) {
      return { connected: false, reason: `未找到已加载的 ${MODEL_ID}` };
    }
    return { connected: true, reason: `${MODEL_ID} 已就绪` };
  } catch {
    return { connected: false, reason: '无法连接本机模型接口' };
  }
}

export class LiveAdvisor {
  constructor({
    fetchImpl = fetch,
    advise = askLocalModel,
    fastPolicy = evaluateFastPolicy,
    now = Date.now,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.advise = advise;
    this.fastPolicy = fastPolicy;
    this.now = now;
    this.lastEvent = null;
    this.captureMetrics = null;
    this.publicHistory = [];
    this.signature = null;
    this.context = null;
    this.controller = null;
    this.requestId = 0;
    this.retryAt = 0;
    this.unstableSince = null;
    this.unstableCount = 0;
    this.unstableContext = null;
    this.heldAdvice = null;
    this.stats = {
      started: 0,
      completed: 0,
      canceled: 0,
      errors: 0,
      timeouts: 0,
      cancel_reasons: {},
      last_cancel_reason: null,
    };
    this.result = { status: 'waiting', reason: '等待 VisionBox 对局画面' };
  }

  _cancel(reason = 'unspecified') {
    this.requestId += 1;
    if (this.controller) {
      this.stats.canceled += 1;
      this.stats.cancel_reasons[reason] = (this.stats.cancel_reasons[reason] ?? 0) + 1;
      this.stats.last_cancel_reason = reason;
      this.controller.abort(reason);
    }
    this.controller = null;
    this.heldAdvice = null;
  }

  _resetUnstable() {
    this.unstableSince = null;
    this.unstableCount = 0;
    this.unstableContext = null;
  }

  _finalizeUnstable(context = this.unstableContext, event = this.lastEvent) {
    this._cancel('unstable_state');
    this.signature = null;
    this.context = null;
    this._resetUnstable();
    this.result = {
      status: 'waiting',
      reason: context?.reason ?? '等待稳定的视觉状态',
      frame_id: event?.frame_id,
    };
  }

  _expireUnstable() {
    if (this.unstableSince === null) return;
    if (this.now() - this.unstableSince >= UNSTABLE_GRACE_MS) {
      this._finalizeUnstable();
    }
  }

  _holdTransient(context, event) {
    const hasActiveDecision = this.signature !== null
      || this.controller !== null
      || this.result.status === 'ready'
      || this.heldAdvice !== null;
    if (!hasActiveDecision) {
      this.result = { status: 'waiting', reason: context.reason, frame_id: event.frame_id };
      return;
    }

    if (this.unstableSince === null) {
      this.unstableSince = this.now();
      this.unstableCount = 0;
      if (this.result.status === 'ready') this.heldAdvice = this.result;
    }
    this.unstableCount += 1;
    this.unstableContext = context;
    this.result = {
      status: 'waiting',
      reason: `视觉状态短暂不稳定：${context.reason}`,
      frame_id: event.frame_id,
      transient: true,
    };

    if (
      this.unstableCount >= UNSTABLE_GRACE_EVENTS
      || this.now() - this.unstableSince >= UNSTABLE_GRACE_MS
    ) {
      this._finalizeUnstable(context, event);
    }
  }

  ingest(event) {
    this._expireUnstable();
    if (!event) return;
    if (this.lastEvent && event.frame_id <= this.lastEvent.frame_id) {
      const restarted = event.frame_id < this.lastEvent.frame_id - 10
        && Date.parse(event.timestamp) > Date.parse(this.lastEvent.timestamp);
      if (!restarted) return;
      this._cancel('source_restart');
      this.lastEvent = null;
      this.publicHistory = [];
      this.signature = null;
      this.context = null;
      this._resetUnstable();
    }

    this.lastEvent = event;
    const log = String(event.state?.data?.texts_by_region?.public_log ?? '').trim();
    const normalizedLog = normalizeDecisionText(log);
    const previousLog = normalizeDecisionText(this.publicHistory.at(-1));
    if (log && log.length <= 160 && normalizedLog && normalizedLog !== previousLog) {
      this.publicHistory.push(log);
      this.publicHistory = this.publicHistory.slice(-8);
    }

    if (event.event === 'error' || !event.state) {
      this._cancel('vision_error');
      this.signature = null;
      this.context = null;
      this._resetUnstable();
      this.result = { status: 'waiting', reason: event.message ?? '等待视觉识别恢复' };
      return;
    }

    const context = buildContext(event, this.publicHistory);
    if (context.kind === 'insufficient' || context.kind === 'waiting') {
      this._holdTransient(context, event);
      return;
    }

    const recoveredFromUnstable = this.unstableSince !== null;
    const heldAdvice = this.heldAdvice;
    this._resetUnstable();

    const signature = buildDecisionSignature(context);
    const sameDecision = signature === this.signature;
    if (sameDecision) {
      this.context = context;
      if (this.result.status === 'error' && this.now() < this.retryAt) return;
      if (heldAdvice && !this.controller) {
        this.heldAdvice = null;
        this.result = {
          ...heldAdvice,
          frame_id: event.frame_id,
          observed_at: event.timestamp,
        };
        return;
      }
      if (this.controller) {
        if (recoveredFromUnstable) {
          this.result = {
            status: 'thinking',
            reason: '视觉状态已恢复，继续分析当前局面',
            frame_id: event.frame_id,
          };
        }
        return;
      }
      if (this.result.status === 'ready') return;
    } else {
      const reason = decisionChangeReason(this.context, context);
      this._cancel(reason);
      this.signature = signature;
      this.context = context;
    }

    let fastDecision;
    try {
      fastDecision = this.fastPolicy(context);
    } catch (error) {
      fastDecision = {
        status: 'abstain',
        reason: `快速策略异常，转交局势分析：${error?.message ?? error}`,
        policy_ms: 0,
      };
    }
    if (fastDecision.status === 'ready') {
      this.result = {
        ...fastDecision,
        frame_id: event.frame_id,
        observed_at: event.timestamp,
      };
      return;
    }

    if (context.kind === 'rescue' && context.candidates[0]?.id === 'verify-dying-role') {
      this.result = {
        status: 'ready', kind: context.kind, frame_id: event.frame_id,
        advice: context.candidates[0].label,
        reason: '画面文字未能把濒死者与身份座位可靠对应，先看其身份再决定是否用桃。',
        requires_validation: true,
        unreadable_card_count: context.unreadable_card_count,
        model_ms: 0,
        fast_policy_ms: fastDecision.policy_ms,
      };
      return;
    }

    this.result = {
      status: 'thinking',
      reason: '正在结合当前局势分析',
      frame_id: event.frame_id,
      fast_policy_ms: fastDecision.policy_ms,
      fast_policy_reason: fastDecision.reason,
    };
    const requestId = this.requestId;
    const controller = new AbortController();
    this.controller = controller;
    this.stats.started += 1;
    void this._run(context, requestId, controller, fastDecision);
  }

  async _run(context, requestId, controller, fastDecision) {
    try {
      const advice = await this.advise(context, { signal: controller.signal });
      if (requestId === this.requestId) {
        this.stats.completed += 1;
        const enrichedAdvice = {
          ...advice,
          fast_policy_ms: fastDecision?.policy_ms,
          fast_policy_reason: fastDecision?.reason,
        };
        if (this.unstableSince !== null) {
          this.heldAdvice = enrichedAdvice;
        } else {
          this.result = enrichedAdvice;
        }
      }
    } catch (error) {
      if (requestId !== this.requestId) return;
      const timedOut = error?.name === 'TimeoutError';
      this.stats.errors += 1;
      if (timedOut) this.stats.timeouts += 1;
      this.retryAt = this.now() + 5000;
      this.result = {
        status: 'error', frame_id: context.frame_id,
        reason: timedOut ? '本机模型超过 6 秒，已取消这次建议' : String(error?.message ?? error),
      };
    } finally {
      if (requestId === this.requestId) this.controller = null;
    }
  }

  snapshot() {
    this._expireUnstable();
    const ageMs = this.lastEvent ? this.now() - Date.parse(this.lastEvent.timestamp) : null;
    const captureAgeMs = this.captureMetrics?.last_capture_at
      ? this.now() - Date.parse(this.captureMetrics.last_capture_at)
      : null;
    const captureFresh = this.captureMetrics?.running === true
      && !this.captureMetrics.capture_error
      && captureAgeMs !== null
      && captureAgeMs >= -1000
      && captureAgeMs <= MAX_CAPTURE_AGE_MS;
    const eventFresh = ageMs !== null && ageMs >= -1000 && ageMs <= MAX_EVENT_AGE_MS;
    if (this.lastEvent && !(this.captureMetrics ? captureFresh : eventFresh)) {
      return {
        status: 'stale', reason: '识别画面已过期，请核对游戏是否仍在当前操作',
        age_ms: ageMs, capture_age_ms: captureAgeMs,
      };
    }
    return {
      ...this.result,
      skill_hints: buildSkillHints(this.lastEvent?.state?.data),
      age_ms: ageMs,
      capture_age_ms: captureAgeMs,
    };
  }

  async poll() {
    const [metricsResponse, eventsResponse] = await Promise.all([
      this.fetchImpl(`${VISION_URL}/metrics`, {
        signal: AbortSignal.timeout(1500), cache: 'no-store',
      }),
      this.fetchImpl(`${VISION_URL}/events?limit=1`, {
        signal: AbortSignal.timeout(1500), cache: 'no-store',
      }),
    ]);
    if (!metricsResponse.ok) throw new Error(`VisionBox 指标返回 ${metricsResponse.status}`);
    if (!eventsResponse.ok) throw new Error(`VisionBox 事件返回 ${eventsResponse.status}`);
    const [metrics, payload] = await Promise.all([metricsResponse.json(), eventsResponse.json()]);
    this.captureMetrics = metrics;
    this.ingest(payload.events?.at(-1));
  }
}

function serve() {
  const advisor = new LiveAdvisor();
  const revision = (() => {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 1000,
      }).trim();
    } catch {
      return '未知';
    }
  })();
  let modelStatus = { connected: false, reason: '检查中' };
  let probingModel = false;
  const probe = async () => {
    if (probingModel) return;
    probingModel = true;
    try { modelStatus = await probeLocalModel(); }
    finally { probingModel = false; }
  };
  const modelTimer = setInterval(probe, 3000);
  void probe();
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      await advisor.poll();
    } catch (error) {
      advisor._cancel('visionbox_poll_error');
      advisor.lastEvent = null;
      advisor.captureMetrics = null;
      advisor.publicHistory = [];
      advisor.signature = null;
      advisor.context = null;
      advisor._resetUnstable();
      advisor.result = { status: 'error', reason: `无法读取 VisionBox：${error.message}` };
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(poll, 250);
  void poll();

  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:8765');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    if (request.method !== 'GET' || !['/health', '/advice'].includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.writeHead(200).end(JSON.stringify(request.url === '/health'
      ? {
        ok: true, source: VISION_URL, revision,
        model_connected: modelStatus.connected, model_reason: modelStatus.reason,
        latest_frame_id: advisor.lastEvent?.frame_id ?? null, stats: advisor.stats,
      }
      : advisor.snapshot()));
  });
  server.listen(PORT, HOST, () => console.log(`Live advisor: http://${HOST}:${PORT}/advice`));
  const close = () => {
    clearInterval(timer);
    clearInterval(modelTimer);
    advisor._cancel('shutdown');
    server.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve();
