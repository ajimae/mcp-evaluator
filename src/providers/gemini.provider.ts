import type { GoogleGenAI } from '@google/genai';
import type {
  Content,
  FunctionCall,
  FunctionDeclaration,
  GenerateContentResponse,
  Part,
} from '@google/genai';

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

const DEFAULT_VERTEX_LOCATION = 'us-central1';

/**
 * Gemini {@link ModelProvider} — Vertex AI when GOOGLE_CLOUD_PROJECT/GOOGLE_GENAI_USE_VERTEXAI is
 * set (application-default credentials), else the Gemini Developer API (GEMINI_API_KEY).
 *
 * The SDK is an optional peer dependency loaded by {@link GeminiProvider.create}.
 */
export class GeminiProvider implements ModelProvider {
  readonly provider = 'gemini';

  private constructor(
    readonly modelId: string,
    private readonly client: GoogleGenAI
  ) {}

  static async create(modelId: string): Promise<GeminiProvider> {
    const sdk = await importOptional<GoogleGenAiModule>('@google/genai', 'gemini');
    return new GeminiProvider(modelId, createGoogleClient(sdk));
  }

  async generateWithTools(
    messages: ProviderMessage[],
    tools: MCPToolDefinition[],
    systemPrompt?: string
  ): Promise<ModelTurn> {
    const response = await this.client.models.generateContent({
      model: this.modelId,
      contents: messages.map(toGoogleContent),
      config: {
        systemInstruction: systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        // An empty `functionDeclarations` list is rejected, so drop `tools` for tool-free turns.
        ...(tools.length > 0
          ? { tools: [{ functionDeclarations: tools.map(toFunctionDeclaration) }] }
          : {}),
      },
    });

    const toolCalls = (response.functionCalls ?? []).map(toToolCallRequest);
    const text = extractText(response);

    return {
      textContent: text,
      toolCalls,
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      rawContent: toRawContent(text, toolCalls),
    };
  }
}

interface GoogleGenAiModule {
  GoogleGenAI: new (options: Record<string, unknown>) => GoogleGenAI;
}

/** Builds the Google client for whichever backend the environment selects (Vertex vs Gemini API). */
function createGoogleClient(sdk: GoogleGenAiModule): GoogleGenAI {
  if (useVertex()) {
    const project = process.env['GOOGLE_CLOUD_PROJECT'];
    if (!project) {
      throw new Error(
        'Vertex AI backend selected but GOOGLE_CLOUD_PROJECT is not set. Set it, or unset GOOGLE_GENAI_USE_VERTEXAI to use the Gemini Developer API.'
      );
    }
    return new sdk.GoogleGenAI({
      vertexai: true,
      project,
      location: process.env['GOOGLE_CLOUD_LOCATION'] ?? DEFAULT_VERTEX_LOCATION,
    });
  }

  const apiKey = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'Gemini Developer API backend selected but neither GEMINI_API_KEY nor GOOGLE_API_KEY is set.'
    );
  }
  return new sdk.GoogleGenAI({ apiKey });
}

function useVertex(): boolean {
  return (
    process.env['GOOGLE_GENAI_USE_VERTEXAI'] === 'true' ||
    Boolean(process.env['GOOGLE_CLOUD_PROJECT'])
  );
}

/** Concatenates text parts directly (avoids the SDK's response.text getter, which warns when functionCall parts exist). */
function extractText(response: GenerateContentResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => part.text)
    .filter((text): text is string => typeof text === 'string')
    .join('');
}

function toFunctionDeclaration(tool: MCPToolDefinition): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.inputSchema,
  };
}

function toGoogleContent(message: ProviderMessage): Content {
  const role = message.role === 'assistant' ? 'model' : 'user';
  if (typeof message.content === 'string') {
    return { role, parts: [{ text: message.content }] };
  }
  return { role, parts: message.content.map(blockToPart) };
}

function blockToPart(block: ContentBlock): Part {
  if (block.type === 'text') {
    return { text: block.text };
  }
  if (block.type === 'tool_use') {
    return { functionCall: { name: block.name, args: block.input } };
  }
  return {
    functionResponse: { name: block.toolName, response: { result: block.content } },
  };
}

function toToolCallRequest(call: FunctionCall): ToolCallRequest {
  return {
    id: call.id ?? `google-tool-${crypto.randomUUID()}`,
    name: call.name ?? '',
    input: call.args ?? {},
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
