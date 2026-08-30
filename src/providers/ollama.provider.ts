import { z } from 'zod';

import type {
  ContentBlock,
  MCPToolDefinition,
  ModelProvider,
  ModelTurn,
  ProviderMessage,
  ToolCallRequest,
} from './types.js';
import { DEFAULT_SYSTEM_PROMPT } from './default-system-prompt.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';

/** Abort a stalled Ollama call so a hung server can't block the eval run. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Resolves `OLLAMA_BASE_URL`, defaulting to the standard local daemon. */
function resolveOllamaBaseUrl(): string {
  const configured = process.env['OLLAMA_BASE_URL']?.trim();
  if (!configured) return DEFAULT_BASE_URL;

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(`OLLAMA_BASE_URL "${configured}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`OLLAMA_BASE_URL "${configured}" must be an http(s) URL.`);
  }
  return parsed.origin;
}

/** Shape of a single Ollama `/api/chat` tool call (no id is returned, so we synthesize one). */
const ollamaToolCallSchema = z.object({
  function: z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).default({}),
  }),
});

/** Validated subset of the Ollama `/api/chat` response we depend on. */
const ollamaChatResponseSchema = z.object({
  message: z.object({
    content: z.string().default(''),
    tool_calls: z.array(ollamaToolCallSchema).default([]),
  }),
  prompt_eval_count: z.number().default(0),
  eval_count: z.number().default(0),
});

/**
 * Ollama-backed {@link ModelProvider} for evaluating local models. Talks to the Ollama HTTP API
 * directly, so it needs no SDK. Set `OLLAMA_BASE_URL` to point at a non-default server.
 */
export class OllamaProvider implements ModelProvider {
  readonly provider = 'ollama';
  private readonly baseUrl: string;

  constructor(readonly modelId: string) {
    this.baseUrl = resolveOllamaBaseUrl();
  }

  static create(modelId: string): Promise<OllamaProvider> {
    return Promise.resolve(new OllamaProvider(modelId));
  }

  async generateWithTools(
    messages: ProviderMessage[],
    tools: MCPToolDefinition[],
    systemPrompt?: string
  ): Promise<ModelTurn> {
    const response = await fetch(new URL('/api/chat', this.baseUrl), {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.modelId,
        stream: false,
        ...(tools.length > 0 ? { tools: tools.map(toOllamaTool) } : {}),
        messages: [
          { role: 'system', content: systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
          ...messages.flatMap(toOllamaMessages),
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama chat failed: ${response.status} ${await response.text()}`);
    }

    const body = ollamaChatResponseSchema.parse(await response.json());
    const toolCalls = body.message.tool_calls.map(toToolCallRequest);

    return {
      textContent: body.message.content,
      toolCalls,
      inputTokens: body.prompt_eval_count,
      outputTokens: body.eval_count,
      rawContent: toRawContent(body.message.content, toolCalls),
    };
  }
}

function toOllamaTool(tool: MCPToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

function toOllamaMessages(message: ProviderMessage): Record<string, unknown>[] {
  if (typeof message.content === 'string') {
    return [{ role: message.role, content: message.content }];
  }

  if (message.role === 'assistant') {
    return [toAssistantMessage(message.content)];
  }

  return message.content.map(toToolResultMessage);
}

function toAssistantMessage(blocks: ContentBlock[]): Record<string, unknown> {
  const text = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  const toolCalls = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => {
      return block.type === 'tool_use';
    })
    .map((block) => ({ function: { name: block.name, arguments: block.input } }));

  return {
    role: 'assistant',
    content: text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function toToolResultMessage(block: ContentBlock): Record<string, unknown> {
  if (block.type !== 'tool_result') {
    return { role: 'user', content: block.type === 'text' ? block.text : '' };
  }
  return { role: 'tool', content: block.content };
}

function toToolCallRequest(call: z.infer<typeof ollamaToolCallSchema>): ToolCallRequest {
  return {
    // Ollama returns no tool-call id; synthesize one so tool results can reference it.
    id: `ollama-tool-${crypto.randomUUID()}`,
    name: call.function.name,
    input: call.function.arguments as Record<string, unknown>,
  };
}

function toRawContent(text: string, toolCalls: ToolCallRequest[]): ContentBlock[] {
  const blocks: ContentBlock[] = text ? [{ type: 'text', text }] : [];
  return blocks.concat(
    toolCalls.map((call) => ({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.input,
    }))
  );
}
