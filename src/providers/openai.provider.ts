import type OpenAI from 'openai';

import type {
  ContentBlock,
  MCPToolDefinition,
  ModelProvider,
  ModelTurn,
  ProviderMessage,
  ToolCallRequest,
} from './types.js';
import { DEFAULT_SYSTEM_PROMPT } from './default-system-prompt.js';
import { importOptional } from './optional-dependency.js';

const MAX_COMPLETION_TOKENS = 4096;

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

/**
 * OpenAI-backed {@link ModelProvider} using the Chat Completions tool-calling API. Reads
 * `OPENAI_API_KEY` from the environment via the SDK's default client; `OPENAI_BASE_URL` points it
 * at an OpenAI-compatible endpoint (Azure OpenAI, vLLM, OpenRouter, LM Studio, ...), which is how
 * this provider covers backends the harness has no dedicated adapter for.
 *
 * The SDK is an optional peer dependency loaded by {@link OpenAIProvider.create}.
 */
export class OpenAIProvider implements ModelProvider {
  readonly provider = 'openai';

  private constructor(
    readonly modelId: string,
    private readonly client: OpenAI
  ) {}

  static async create(modelId: string): Promise<OpenAIProvider> {
    const sdk = await importOptional<{ default: new (options?: unknown) => OpenAI }>(
      'openai',
      'openai'
    );
    return new OpenAIProvider(modelId, new sdk.default());
  }

  async generateWithTools(
    messages: ProviderMessage[],
    tools: MCPToolDefinition[],
    systemPrompt?: string
  ): Promise<ModelTurn> {
    const response = await this.client.chat.completions.create({
      model: this.modelId,
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      // The API rejects an empty `tools` array, so omit the key entirely for tool-free turns
      // (the LLM-as-a-judge calls, for instance).
      ...(tools.length > 0 ? { tools: tools.map(toOpenAITool) } : {}),
      messages: [
        { role: 'system', content: systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
        ...messages.flatMap(toOpenAIMessages),
      ],
    });

    const message = response.choices[0]?.message;
    const toolCalls = extractToolCalls(message?.tool_calls ?? []);

    return {
      textContent: message?.content ?? '',
      toolCalls,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      rawContent: toRawContent(message?.content ?? '', toolCalls),
    };
  }
}

function toOpenAITool(tool: MCPToolDefinition): ChatTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

/** One {@link ProviderMessage} can expand into several OpenAI messages (each tool result is its own). */
function toOpenAIMessages(message: ProviderMessage): ChatMessage[] {
  if (typeof message.content === 'string') {
    return [{ role: message.role, content: message.content }];
  }

  if (message.role === 'assistant') {
    return [toAssistantMessage(message.content)];
  }

  return message.content.map(toToolResultMessage);
}

function toAssistantMessage(blocks: ContentBlock[]): ChatMessage {
  const text = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  const toolCalls = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => {
      return block.type === 'tool_use';
    })
    .map((block) => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: JSON.stringify(block.input) },
    }));

  return {
    role: 'assistant',
    content: text || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function toToolResultMessage(block: ContentBlock): ChatMessage {
  if (block.type !== 'tool_result') {
    return { role: 'user', content: block.type === 'text' ? block.text : '' };
  }
  return { role: 'tool', tool_call_id: block.toolUseId, content: block.content };
}

function extractToolCalls(
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]
): ToolCallRequest[] {
  return toolCalls
    .filter((call) => call.type === 'function')
    .map((call) => ({
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
    }));
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
