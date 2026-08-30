/**
 * Provider-facing types: a minimal, provider-agnostic shape for one agentic turn so the
 * {@link runAgenticLoop loop} and {@link MCPEvalClient MCP client} never depend on a specific SDK.
 * Each concrete provider ({@link AnthropicProvider}, {@link OpenAIProvider}, {@link OllamaProvider})
 * translates to and from its own wire format.
 */

/* eslint-disable @typescript-eslint/no-unused-vars -- referenced only by {@link} in JSDoc. */
import type { runAgenticLoop } from '../mcp/agentic-loop.js';
import type { MCPEvalClient } from '../mcp/mcp-client.js';
import type { AnthropicProvider } from './anthropic.provider.js';
import type { OpenAIProvider } from './openai.provider.js';
import type { OllamaProvider } from './ollama.provider.js';
/* eslint-enable @typescript-eslint/no-unused-vars */

import type { ModelProviderName } from '../types.js';

/** A tool definition as exposed to the model, sourced from MCP `tools/list`. */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Provider-agnostic content block used to rebuild conversation history across turns. `tool_result`
 * carries both `toolUseId` (Anthropic/OpenAI match results by id) and `toolName` (Google's Gemini
 * matches `functionResponse` by name), so a single shape works across every provider.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; toolName: string; content: string };

/** A message in the running conversation. */
export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/** A tool call the model requested in a turn. */
export interface ToolCallRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The normalized result of one model turn. */
export interface ModelTurn {
  textContent: string;
  toolCalls: ToolCallRequest[];
  inputTokens: number;
  outputTokens: number;
  rawContent: ContentBlock[];
}

/**
 * A unified interface over LLM backends. The harness only ever calls {@link generateWithTools}.
 */
export interface ModelProvider {
  /** Provider family, e.g. `anthropic`. */
  readonly provider: ModelProviderName;
  /** Concrete model id, e.g. `claude-haiku-4-5-20251001`. */
  readonly modelId: string;
  generateWithTools(
    messages: ProviderMessage[],
    tools: MCPToolDefinition[],
    systemPrompt?: string
  ): Promise<ModelTurn>;
}
