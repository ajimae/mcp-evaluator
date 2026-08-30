/**
 * Default system prompt used when neither the scenario nor the run config supplies one.
 *
 * Deliberately server-agnostic: it says nothing about a particular domain or tool vocabulary, so
 * the model's tool choice is driven purely by the descriptions the MCP server advertises. Override
 * it per run (`systemPrompt` in the config) or per scenario when you want to test how much prompt
 * guidance a model needs.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant with access to a set of tools.
Use the available tools to answer the user's request — do not make up data you could look up.
When no tool fits the request, say so plainly instead of guessing.`;
