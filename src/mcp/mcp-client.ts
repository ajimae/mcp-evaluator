import type { McpServerConfig } from '../config/config.js';
import type { MCPToolDefinition } from '../providers/types.js';

/**
 * A minimal MCP client over Streamable HTTP, built on `fetch` — no SDK, no transport plugins.
 *
 * It speaks plain JSON-RPC to whatever endpoint the config points at, so it works with any
 * HTTP-accessible MCP server. Server-specific needs are expressed through configuration rather
 * than code: custom auth or tenancy goes in `headers`, and gateways that gate tools server-side
 * get them via `requestMeta` / `sendEnabledToolsMeta`.
 *
 * Responses may come back as JSON or as a single-message SSE stream; both are handled.
 */
export class MCPEvalClient {
  private sessionId: string | null = null;
  private requestId = 0;
  private negotiatedProtocolVersion: string;
  /** Stable per-session id, echoed on every request so server logs can correlate a run. */
  private readonly clientSessionId = randomId();
  private enabledTools: string[] | undefined;

  constructor(private readonly config: McpServerConfig) {
    this.negotiatedProtocolVersion = config.protocolVersion;
  }

  /**
   * Performs the MCP `initialize` handshake and sends `notifications/initialized`.
   *
   * @param enabledTools Tool names this session cares about. Only forwarded to the server when
   *   `sendEnabledToolsMeta` is on; the advertised list is filtered client-side regardless.
   */
  async connect(enabledTools?: string[]): Promise<void> {
    this.enabledTools = enabledTools;

    const result = await this.request<InitializeResult>('initialize', {
      protocolVersion: this.config.protocolVersion,
      capabilities: {},
      clientInfo: this.config.clientInfo,
    });

    if (result.protocolVersion) {
      this.negotiatedProtocolVersion = result.protocolVersion;
    }

    // Required by the spec before any other request; some servers reject `tools/list` without it.
    await this.notify('notifications/initialized');
  }

  /**
   * Lists the tools available to this session, narrowed to `toolsToEnable` when the scenario set
   * one. Filtering here (rather than trusting the server) keeps scenario tool-gating portable.
   */
  async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this.request<ToolsListResult>('tools/list', {});
    const tools = (result.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: normalizeSchema(tool.inputSchema),
    }));

    if (!this.enabledTools || this.enabledTools.length === 0) return tools;

    const allowed = new Set(this.enabledTools);
    return tools.filter((tool) => allowed.has(tool.name));
  }

  /** Calls a tool. Protocol errors are returned (not thrown) as an `isError` result, for grading. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.request<ToolCallResult>('tools/call', { name, arguments: args });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }

  /** Closes the MCP session. Safe to call even if never connected. */
  async disconnect(): Promise<void> {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = null;

    try {
      await fetch(this.config.url, { method: 'DELETE', headers: this.headers(sessionId) });
    } catch {
      // A server that does not support session teardown must not fail the eval run.
    }
  }

  /** Sends a JSON-RPC request and returns its `result`, throwing on transport or protocol errors. */
  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = ++this.requestId;
    const response = await this.post({ jsonrpc: '2.0', id, method, params: this.withMeta(params) });

    if (!response.ok) {
      throw new Error(`${method} failed: HTTP ${response.status} ${await safeText(response)}`);
    }

    // `initialize` is the only response that carries a new session id.
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;

    const body = await readJsonRpc<T>(response);
    if (body === null) {
      throw new Error(`${method} returned an empty response body.`);
    }
    if (body.error) {
      throw new Error(`${method} error ${body.error.code}: ${body.error.message}`);
    }
    return body.result as T;
  }

  /** Sends a JSON-RPC notification (no id, no response expected). */
  private async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const response = await this.post({ jsonrpc: '2.0', method, params: this.withMeta(params) });
    // 202/204 are the expected replies; anything else is informational only, never fatal.
    await response.body?.cancel();
  }

  private async post(payload: Record<string, unknown>): Promise<Response> {
    const response = await fetch(this.config.url, {
      method: 'POST',
      headers: {
        ...this.headers(this.sessionId),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    }).catch((error: unknown) => {
      throw new Error(`Request to ${this.config.url} failed: ${describeFetchError(error)}`);
    });

    return response;
  }

  private headers(sessionId: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.config.headers,
      'x-session-id': this.clientSessionId,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    // Only sent after the handshake — the spec forbids it on `initialize`.
    if (this.requestId > 0) headers['mcp-protocol-version'] = this.negotiatedProtocolVersion;
    return headers;
  }

  /** Merges configured `_meta` (and optionally the enabled tool list) into request params. */
  private withMeta(params: Record<string, unknown>): Record<string, unknown> {
    const meta: Record<string, unknown> = { ...this.config.requestMeta };
    if (this.config.sendEnabledToolsMeta && this.enabledTools) {
      meta['tools'] = this.enabledTools;
    }

    return Object.keys(meta).length > 0 ? { ...params, _meta: meta } : params;
  }
}

/** Reads a JSON-RPC response body, transparently unwrapping a `text/event-stream` reply. */
async function readJsonRpc<T>(response: Response): Promise<JsonRpcResponse<T> | null> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (text.trim() === '') return null;

  const payload = contentType.includes('text/event-stream') ? extractSseData(text) : text;
  if (payload === null) return null;

  try {
    return JSON.parse(payload) as JsonRpcResponse<T>;
  } catch {
    throw new Error(`Expected a JSON-RPC response but got: ${truncate(text, 300)}`);
  }
}

/**
 * Pulls the JSON-RPC message out of an SSE body. Servers may emit keep-alive comments and multiple
 * events; the last `data:` payload that parses as a JSON-RPC message is the response.
 */
function extractSseData(text: string): string | null {
  let current: string[] = [];
  const chunks: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === '') {
      if (current.length > 0) chunks.push(current.join('\n'));
      current = [];
      continue;
    }
    if (rawLine.startsWith('data:')) current.push(rawLine.slice(5).trimStart());
  }
  if (current.length > 0) chunks.push(current.join('\n'));

  for (const chunk of chunks.reverse()) {
    if (chunk.includes('"jsonrpc"')) return chunk;
  }
  return chunks[0] ?? null;
}

function normalizeSchema(schema: unknown): Record<string, unknown> {
  // Some servers omit inputSchema for zero-argument tools; models still need a valid object schema.
  return typeof schema === 'object' && schema !== null
    ? (schema as Record<string, unknown>)
    : { type: 'object', properties: {} };
}

function errorResult(message: string): ToolCallResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'request timed out';
  return error instanceof Error ? error.message : String(error);
}

async function safeText(response: Response): Promise<string> {
  try {
    return truncate(await response.text(), 300);
  } catch {
    return '';
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

interface InitializeResult {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
}

interface ToolsListResult {
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
}

interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}
