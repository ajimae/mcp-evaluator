import type { ModelSpec } from '../types.js';
import type { ModelProvider } from './types.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { OpenAIProvider } from './openai.provider.js';
import { OllamaProvider } from './ollama.provider.js';
import { GeminiProvider } from './gemini.provider.js';

/**
 * Builds the concrete {@link ModelProvider} for a {@link ModelSpec}. The provider family is a closed
 * union, so the switch is exhaustive.
 *
 * Async because each provider imports its SDK on demand — evaluating with one provider must not
 * require the other three to be installed.
 */
export function createProvider(spec: ModelSpec): Promise<ModelProvider> {
  switch (spec.provider) {
    case 'anthropic':
      return AnthropicProvider.create(spec.modelId);
    case 'openai':
      return OpenAIProvider.create(spec.modelId);
    case 'ollama':
      return OllamaProvider.create(spec.modelId);
    case 'gemini':
      return GeminiProvider.create(spec.modelId);
  }
}
