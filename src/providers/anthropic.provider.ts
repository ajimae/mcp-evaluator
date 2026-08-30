import type Anthropic from '@anthropic-ai/sdk';

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

const MAX_TOKENS = 4096;

/**
 * Anthropic-backed {@link ModelProvider}. Reads `ANTHROPIC_API_KEY` from the environment via the
 * SDK's default client; `ANTHROPIC_BASE_URL` redirects it at a proxy or gateway.
 *
 * The SDK is an optional peer dependency loaded by {@link AnthropicProvider.create}.
 */
export class AnthropicProvider implements ModelProvider {
  readonly provider = 'anthropic';

  private constructor(
    readonly modelId: string,
    private readonly client: Anthropic
  ) {}

  static async create(modelId: string): Promise<AnthropicProvider> {
    const sdk = await importOptional<{ default: new (options?: unknown) => Anthropic }>(
      '@anthropic-ai/sdk',
      'anthropic'
    );
    return new AnthropicProvider(modelId, new sdk.default());
  }

  async generateWithTools(
    messages: ProviderMessage[],
    tools: MCPToolDefinition[],
    systemPrompt?: string
  ): Promise<ModelTurn> {
    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: MAX_TOKENS,
      system: systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      // Omitted rather than sent empty, so tool-free turns (the LLM judge) behave identically
      // across providers — some reject `tools: []`.
      ...(tools.length > 0 ? { tools: tools.map(toAnthropicTool) } : {}),
      messages: messages.map(toAnthropicMessage),
    });

    return {
      textContent: extractText(response.content),
      toolCalls: extractToolCalls(response.content),
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      rawContent: response.content.map(toContentBlock),
    };
  }
}

function toAnthropicTool(tool: MCPToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
  };
}

function toAnthropicMessage(message: ProviderMessage): Anthropic.MessageParam {
  if (typeof message.content === 'string') {
    return { role: message.role, content: message.content };
  }

  const content: Anthropic.ContentBlockParam[] = message.content.map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text };
    }
    if (block.type === 'tool_use') {
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    }
    return { type: 'tool_result', tool_use_id: block.toolUseId, content: block.content };
  });

  return { role: message.role, content };
}

function extractText(blocks: Anthropic.ContentBlock[]): string {
  return blocks
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function extractToolCalls(blocks: Anthropic.ContentBlock[]): ToolCallRequest[] {
  return blocks
    .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
    .map((block) => ({
      id: block.id,
      name: block.name,
      input: block.input as Record<string, unknown>,
    }));
}

function toContentBlock(block: Anthropic.ContentBlock): ContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input as Record<string, unknown>,
    };
  }
  // Thinking / server-tool blocks are surfaced as empty text so history stays valid without
  // leaking internal reasoning into the trace.
  return { type: 'text', text: '' };
}
