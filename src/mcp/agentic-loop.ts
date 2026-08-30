import type {
  ContentBlock,
  ModelProvider,
  ProviderMessage,
  ToolCallRequest,
} from '../providers/types.js';
import type { MCPEvalClient } from './mcp-client.js';
import type { ResolvedScenario, ScenarioRun, ToolCallRecord } from '../types.js';

/* eslint-disable @typescript-eslint/no-unused-vars -- referenced only by {@link} in JSDoc. */
import type { scoreScenario } from '../scoring/deterministic.js';
/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * Runs the agentic tool-use loop for one scenario against one model: call the model, execute any
 * tool calls via MCP, feed results back, and repeat until the model stops calling tools or
 * `maxTurns` is hit. Returns the raw {@link ScenarioRun} for {@link scoreScenario} to grade.
 */
export async function runAgenticLoop(
  scenario: ResolvedScenario,
  provider: ModelProvider,
  mcpClient: MCPEvalClient,
  defaultSystemPrompt?: string
): Promise<ScenarioRun> {
  const startedAt = Date.now();
  const tools = await mcpClient.listTools();
  const availableToolNames = new Set(tools.map((tool) => tool.name));
  const expectedToolNames = new Set(scenario.expectedToolCalls.map((call) => call.toolName));
  const systemPrompt = scenario.systemPrompt ?? defaultSystemPrompt;

  const messages: ProviderMessage[] = scenario.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  const toolCalls: ToolCallRecord[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let finalText = '';
  let turns = 0;
  let reachedMaxTurns = true;

  for (let turn = 0; turn < scenario.maxTurns; turn++) {
    turns = turn + 1;
    const modelTurn = await provider.generateWithTools(messages, tools, systemPrompt);
    inputTokens += modelTurn.inputTokens;
    outputTokens += modelTurn.outputTokens;
    messages.push({ role: 'assistant', content: modelTurn.rawContent });

    // Keep the latest non-empty assistant text so it survives a maxTurns exit, not just the
    // no-tool-call exit below.
    if (modelTurn.textContent) {
      finalText = modelTurn.textContent;
    }

    if (modelTurn.toolCalls.length === 0) {
      reachedMaxTurns = false;
      break;
    }

    const executed = await executeToolCalls(
      modelTurn.toolCalls,
      mcpClient,
      availableToolNames,
      expectedToolNames
    );

    toolCalls.push(...executed.records);
    messages.push({ role: 'user', content: executed.blocks });
  }

  return {
    toolCalls,
    turns,
    reachedMaxTurns,
    finalText,
    inputTokens,
    outputTokens,
    durationMs: Date.now() - startedAt,
  };
}

interface ExecutedTurn {
  records: ToolCallRecord[];
  blocks: ContentBlock[];
}

async function executeToolCalls(
  toolCalls: ToolCallRequest[],
  mcpClient: MCPEvalClient,
  availableToolNames: Set<string>,
  expectedToolNames: Set<string>
): Promise<ExecutedTurn> {
  const records: ToolCallRecord[] = [];
  const blocks: ContentBlock[] = [];

  for (const toolCall of toolCalls) {
    const executed = await executeToolCall(
      toolCall,
      mcpClient,
      availableToolNames,
      expectedToolNames
    );

    records.push(executed.record);
    blocks.push(executed.block);
  }

  return { records, blocks };
}

async function executeToolCall(
  toolCall: ToolCallRequest,
  mcpClient: MCPEvalClient,
  availableToolNames: Set<string>,
  expectedToolNames: Set<string>
): Promise<{ record: ToolCallRecord; block: ContentBlock }> {
  const isHallucination = !availableToolNames.has(toolCall.name);
  const callStart = Date.now();

  const result = isHallucination
    ? hallucinationResult(toolCall.name)
    : await mcpClient.callTool(toolCall.name, toolCall.input);

  const record: ToolCallRecord = {
    toolName: toolCall.name,
    args: toolCall.input,
    result,
    isExpectedTool: expectedToolNames.has(toolCall.name),
    isHallucination,
    isError: isHallucination || isErrorResult(result),
    latencyMs: Date.now() - callStart,
  };

  const block: ContentBlock = {
    type: 'tool_result',
    toolUseId: toolCall.id,
    toolName: toolCall.name,
    content: serializeToolResult(result),
  };

  return { record, block };
}

function hallucinationResult(toolName: string): unknown {
  return { isError: true, content: [{ type: 'text', text: `Tool "${toolName}" does not exist.` }] };
}

function isErrorResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'isError' in result
    ? (result as { isError?: unknown }).isError === true
    : false;
}

function serializeToolResult(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result);
}
