import { createOpenAIState, type OpenAIState } from "./openai/state.ts";
import { ProviderRegistry, type ProviderRegistryOptions } from "./registry.ts";
import type { ProviderFeature } from "./state.ts";
import { anthropicConnector } from "./anthropic/index.ts";
import { createOpenAIConnector } from "./openai/index.ts";
import { openRouterConnector } from "./openrouter/index.ts";
import { createXaiConnector } from "./xai/index.ts";

// The only built-in provider list. Shared features receive capabilities, not
// provider names or a provider's mutable request settings.
export function createDefaultProviders(state?: OpenAIState, options?: ProviderRegistryOptions, features: readonly ProviderFeature[] = []): ProviderRegistry {
	const settings = state ?? createOpenAIState();
	return new ProviderRegistry([createOpenAIConnector(settings), anthropicConnector, openRouterConnector, createXaiConnector()], options, features);
}
