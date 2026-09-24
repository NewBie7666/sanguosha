import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { askLocalModel, buildContext } from './live-advisor-core.mjs';

const VISION_URL = process.env.VISIONBOX_URL ?? 'http://127.0.0.1:8765';
const HOST = '127.0.0.1';
const PORT = Number(process.env.LIVE_ADVISOR_PORT ?? 8767);
const MAX_EVENT_AGE_MS = 4000;

export class LiveAdvisor {
  constructor({ fetchImpl = fetch, advise = askLocalModel, now = Date.now } = {}) {
    this.fetchImpl = fetchImpl;
    this.advise = advise;
    this.now = now;
    this.lastEvent = null;
    this.publicHistory = [];
    this.signature = null;
    this.controller = null;
    this.requestId = 0;
    this.retryAt = 0;
    this.stats = { started: 0, completed: 0, canceled: 0, errors: 0 };
    this.result = { status: 'waiting', reason: '等待 VisionBox 对局画面' };
  }

  _cancel() {
    this.requestId += 1;
    if (this.controller) {
      this.stats.canceled += 1;
      this.controller.abort();
    }
    this.controller = null;
  }

  ingest(event) {
    if (!event) return;
    if (this.lastEvent && event.frame_id <= this.lastEvent.frame_id) {
      const restarted = event.frame_id < this.lastEvent.frame_id - 10
        && Date.parse(event.timestamp) > Date.parse(this.lastEvent.timestamp);
      if (!restarted) return;
      this._cancel();
      this.lastEvent = null;
      this.publicHistory = [];
      this.signature = null;
    }
    this.lastEvent = event;
    const log = String(event.state?.data?.texts_by_region?.public_log ?? '').trim();
    if (log && log.length <= 160 && log !== this.publicHistory.at(-1)) {
      this.publicHistory.push(log);
      this.publicHistory = this.publicHistory.slice(-8);
    }
    if (event.event === 'error' || !event.state) {
      this._cancel();
      this.signature = null;
      this.result = { status: 'waiting', reason: event.message ?? '等待视觉识别恢复' };
      return;
    }

    const context = buildContext(event, this.publicHistory);
    if (context.kind === 'insufficient' || context.kind === 'waiting') {
      this._cancel();
      this.signature = null;
      this.result = { status: 'waiting', reason: context.reason, frame_id: event.frame_id };
      return;
    }

    const signature = JSON.stringify({
      kind: context.kind,
      prompt: context.prompt.replace(/[\s，。,.、：:；;！!？?]/g, ''),
      hand: context.hand.map((card) => card.name),
    });
    if (signature === this.signature && (this.result.status !== 'error' || this.now() < this.retryAt)) {
      return;
    }
    this._cancel();
    this.signature = signature;
    if (context.kind === 'rescue' && context.candidates[0]?.id === 'verify-dying-role') {
      this.result = {
        status: 'ready', kind: context.kind, frame_id: event.frame_id,
        advice: context.candidates[0].label,
        reason: '画面文字未能把濒死者与身份座位可靠对应，先看其身份再决定是否用桃。',
        requires_validation: true,
        unreadable_card_count: context.unreadable_card_count,
        model_ms: 0,
      };
      return;
    }
    this.result = { status: 'thinking', reason: '正在结合当前局势分析', frame_id: event.frame_id };
    const requestId = this.requestId;
    const controller = new AbortController();
    this.controller = controller;
    this.stats.started += 1;
    void this._run(context, requestId, controller);
  }

  async _run(context, requestId, controller) {
    try {
      const advice = await this.advise(context, { signal: controller.signal });
      if (requestId === this.requestId) {
        this.stats.completed += 1;
        this.result = advice;
      }
    } catch (error) {
      if (requestId !== this.requestId) return;
      this.stats.errors += 1;
      this.retryAt = this.now() + 5000;
      this.result = {
        status: 'error', frame_id: context.frame_id,
        reason: error?.name === 'TimeoutError' ? '本机模型超过 6 秒，已取消这次建议' : String(error?.message ?? error),
      };
    } finally {
      if (requestId === this.requestId) this.controller = null;
    }
  }

  snapshot() {
    const ageMs = this.lastEvent ? this.now() - Date.parse(this.lastEvent.timestamp) : null;
    if (ageMs !== null && (ageMs > MAX_EVENT_AGE_MS || ageMs < -1000)) {
      return { status: 'stale', reason: '识别画面已过期，请核对游戏是否仍在当前操作', age_ms: ageMs };
    }
    return { ...this.result, age_ms: ageMs };
  }

  async poll() {
    const response = await this.fetchImpl(`${VISION_URL}/events?limit=1`, {
      signal: AbortSignal.timeout(1500),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`VisionBox 返回 ${response.status}`);
    const payload = await response.json();
    this.ingest(payload.events?.at(-1));
  }
}

function serve() {
  const advisor = new LiveAdvisor();
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      await advisor.poll();
    } catch (error) {
      advisor._cancel();
      advisor.lastEvent = null;
      advisor.publicHistory = [];
      advisor.signature = null;
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
      ? { ok: true, source: VISION_URL, latest_frame_id: advisor.lastEvent?.frame_id ?? null, stats: advisor.stats }
      : advisor.snapshot()));
  });
  server.listen(PORT, HOST, () => console.log(`Live advisor: http://${HOST}:${PORT}/advice`));
  const close = () => {
    clearInterval(timer);
    advisor._cancel();
    server.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve();
