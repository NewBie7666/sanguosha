import { AGENT_SYSTEM_PROMPT } from './observation';
import type { ModelEndpointConfig, ModelProvider, ProviderRequest, ProviderResponse } from './types';

const ACTION_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'choose_legal_action',
    strict: true,
    schema: {
      type: 'object',
      properties: { action_id: { type: 'string' } },
      required: ['action_id'],
      additionalProperties: false,
    },
  },
};

function buildMessages(input: ProviderRequest): Array<{ role: 'system' | 'user'; content: string }> {
  const retry = input.retry_error
    ? `\n\n上一次选择无效：${input.retry_error}。请只从下面这份最新 legal_actions 中重新选择。`
    : '';
  const context = {
    seat: input.seat,
    observation: input.observation,
    legal_actions: input.legal_actions,
    recent_public_history: input.recent_public_history,
    recent_private_history: input.recent_private_history,
    relevant_rules: input.relevant_rules,
  };
  return [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: `${JSON.stringify(context)}${retry}` },
  ];
}

function unsupportedSchemaError(status: number, message: string): boolean {
  return status === 400 && /response_format|json_schema|json schema|structured output|unsupported parameter/i.test(message);
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly temperature: number;
  private readonly maxTokens?: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ModelEndpointConfig, fetchImpl: typeof fetch = fetch) {
    this.model = config.model;
    this.baseUrl = config.base_url.replace(/\/+$/, '');
    this.apiKey = config.api_key;
    this.temperature = config.temperature ?? 0.2;
    this.maxTokens = config.max_tokens;
    this.timeoutMs = config.timeout_ms ?? 120_000;
    this.fetchImpl = fetchImpl;
  }

  async chooseAction(input: ProviderRequest): Promise<ProviderResponse> {
    const requestBody: Record<string, unknown> = {
      model: this.model,
      messages: buildMessages(input),
      temperature: this.temperature,
      response_format: ACTION_SCHEMA,
      ...(this.maxTokens !== undefined ? { max_tokens: this.maxTokens } : {}),
    };
    const started = performance.now();
    let response = await this.fetchRequest(requestBody);
    let responseText = await response.text();
    if (!response.ok && unsupportedSchemaError(response.status, responseText)) {
      // Some OpenAI-compatible servers only implement JSON mode; shape validation remains local.
      requestBody['response_format'] = { type: 'json_object' };
      response = await this.fetchRequest(requestBody);
      responseText = await response.text();
    }
    if (!response.ok) {
      throw new Error(`model endpoint returned ${response.status}: ${responseText.slice(0, 1000)}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error(`model endpoint returned non-JSON response: ${responseText.slice(0, 500)}`);
    }
    const choice = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0];
    const content = choice?.message?.content;
    const rawText = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('')
        : '';
    if (!rawText) throw new Error('model endpoint response has no assistant content');

    const usage = (payload as { usage?: Record<string, unknown> }).usage;
    const promptTokens = usage?.['prompt_tokens'] ?? usage?.['input_tokens'];
    const completionTokens = usage?.['completion_tokens'] ?? usage?.['output_tokens'];
    const totalTokens = usage?.['total_tokens'];
    return {
      raw_text: rawText,
      request_body: requestBody,
      latency_ms: Math.round(performance.now() - started),
      ...(usage ? {
        usage: {
          ...(typeof promptTokens === 'number' ? { prompt_tokens: promptTokens } : {}),
          ...(typeof completionTokens === 'number' ? { completion_tokens: completionTokens } : {}),
          ...(typeof totalTokens === 'number' ? { total_tokens: totalTokens } : {}),
        },
      } : {}),
    };
  }

  private fetchRequest(body: Record<string, unknown>): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

export function getUsageTotals(responses: ProviderResponse[]): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  return responses.reduce(
    (totals, response) => {
      totals.prompt_tokens += response.usage?.prompt_tokens ?? 0;
      totals.completion_tokens += response.usage?.completion_tokens ?? 0;
      totals.total_tokens += response.usage?.total_tokens ??
        (response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0);
      return totals;
    },
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  );
}
