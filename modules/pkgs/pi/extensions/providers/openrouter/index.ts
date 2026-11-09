import { isModelType, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openRouterModel, requestOpenRouterModels } from "./catalog.ts";
import { piAIRequire } from "../../pi-runtime.ts";
import type { ProviderConnector } from "../state.ts";

const { openrouterProvider } = piAIRequire("providers/openrouter") as typeof import("@earendil-works/pi-ai/providers/openrouter");

// Keep Pi's catalog, auth and request implementations. Live entries only fill
// in models released since that catalog was generated.
export function liveOpenRouterProvider(): ReturnType<typeof openrouterProvider> {
	const base = openrouterProvider();
	let latest: Model<"openai-completions">[] = [];
	const getAllModels = () => {
		const models = base.getAllModels?.() ?? base.getModels();
		const known = new Set(models.filter((model) => isModelType(model, "chat")).map((model) => model.id));
		return [...models, ...latest.filter((model) => !known.has(model.id))];
	};
	return {
		...base,
		getModels: () => getAllModels().filter((model) => isModelType(model, "chat")),
		getAllModels,
		refreshModels: async (context) => {
			if (!context.allowNetwork || context.signal.aborted) return;
			const models = (await requestOpenRouterModels(context.signal)).map(openRouterModel);
			await context.publish({ update: () => { latest = models; } });
		},
	};
}

export const openRouterConnector: ProviderConnector = {
	id: "openrouter",
	label: "OpenRouter",
	providers: ["openrouter"],
	register(pi: ExtensionAPI) {
		pi.registerProvider(liveOpenRouterProvider());
	},
};
