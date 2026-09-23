import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';

interface RpcResponse {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export class McpProcess {
  private readonly child: ChildProcessWithoutNullStreams;

  private readonly pending = new Map<number, {
    resolve: (response: RpcResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  private nextId = 1;

  private stderr = '';

  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.onLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-8000);
    });
    child.on('error', (error) => this.failPending(error));
    child.on('exit', (code, signal) => {
      this.closed = true;
      const exitLabel = typeof code === 'number' && code > 255
        ? `${code} / 0x${code.toString(16).toUpperCase()}`
        : String(code ?? signal);
      this.failPending(new Error(`MCP process exited (${exitLabel})${this.stderr ? `\n${this.stderr}` : ''}`));
    });
  }

  static start(serverUrl: string, seat: 0 | 1, cwd = process.cwd()): McpProcess {
    const entry = path.resolve(cwd, 'src/ai-mcp/server.ts');
    // Windows + recent V8/Node builds have a known Maglev fail-fast crash class
    // (0xC0000409). Self-play values long-lived stability over JIT warmup speed, so
    // disable Maglev for MCP children by default on Windows. Set
    // SGS_MCP_DISABLE_MAGLEV=0 to opt out for diagnosis.
    const disableMaglev = process.platform === 'win32' && process.env.SGS_MCP_DISABLE_MAGLEV !== '0';
    const nodeArgs = [...(disableMaglev ? ['--no-maglev'] : []), '--import', 'tsx', entry];
    const child = spawn(process.execPath, nodeArgs, {
      cwd,
      env: {
        ...process.env,
        SGS_SERVER_URL: serverUrl,
        SGS_SEAT: String(seat),
        SGS_PLAYER_COUNT: '2',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return new McpProcess(child);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'sanguosha-ai-match-runner', version: '1.0.0' },
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>, timeoutMs = 180_000): Promise<T> {
    const response = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const result = response.result as {
      structuredContent?: T;
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    } | undefined;
    if (!result) throw new Error(`MCP ${name} returned no result`);
    if (result.isError) throw new Error(`MCP ${name} failed: ${result.content?.map((part) => part.text).join('\n')}`);
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = result.content?.find((part) => part.type === 'text')?.text;
    if (!text) throw new Error(`MCP ${name} returned no structured content`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`MCP ${name} returned invalid JSON content: ${text.slice(0, 500)}`);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.child.stdin.end();
    await Promise.race([
      new Promise<void>((resolve) => this.child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(() => {
        this.child.kill();
        resolve();
      }, 2000)),
    ]);
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcResponse> {
    if (this.closed) return Promise.reject(new Error('MCP process is closed'));
    const id = this.nextId++;
    const request = { jsonrpc: '2.0', id, method, params };
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms${this.stderr ? `\n${this.stderr}` : ''}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    }).then((response) => {
      if (response.error) throw new Error(`MCP ${method} error ${response.error.code}: ${response.error.message}`);
      return response;
    });
  }

  private onLine(line: string): void {
    let response: RpcResponse;
    try {
      response = JSON.parse(line) as RpcResponse;
    } catch {
      this.failPending(new Error(`MCP stdout contained non-JSON: ${line.slice(0, 300)}`));
      return;
    }
    if (response.id === undefined || response.id === null) return;
    const pending = this.pending.get(Number(response.id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(Number(response.id));
    pending.resolve(response);
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
