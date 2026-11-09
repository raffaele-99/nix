import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBtw } from "./btw/index.ts";
import { registerSubagents } from "./agents/subagents.ts";
import type { OpenAIState } from "./providers/openai/state.ts";
import type { ProviderFeature } from "./providers/state.ts";
import { createDefaultProviders } from "./providers/index.ts";
import { registerGoal } from "./goal/index.ts";
import { createFeatures } from "./features.ts";

export default function pi2(pi: ExtensionAPI, openAISettings?: OpenAIState, features: readonly ProviderFeature[] = createFeatures()): void {
	const providers = createDefaultProviders(openAISettings, {
		usageTools: process.env.PI2_USAGE_TOOL === "1", footer: { statusKeys: ["pi2-goal"] },
	}, features);
	providers.register(pi);
	const goal = registerGoal(pi, { liveWorkerUsage: true });
	registerSubagents(pi, undefined, {
		sessionExtensions: providers.sessionExtensions,
		resolveServiceTier: providers.resolveServiceTier,
		streamOverrides: providers.streamOverrides,
		onWorkerUsage: goal.recordWorkerUsage,
	});
	registerBtw(pi, { sessionExtensions: providers.sessionExtensions });
}
