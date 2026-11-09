import { streamSimple as streamStockSimple } from "@earendil-works/pi-ai/compat";
import { requestConfig } from "../config.ts";
import type { ProviderConnector, StreamOverrideResolver } from "../state.ts";

export function createXaiConnector(): ProviderConnector {
	return {
		id: "xai", label: "xAI", providers: ["xai"],
		register(pi, resolveOverride?: StreamOverrideResolver) {
			pi.registerProvider("xai", {
				api: "openai-responses",
				streamSimple: (model, context, options = {}) => {
					const override = resolveOverride?.(model, options);
					return override
						? override.streamSimple(model, context, options, requestConfig(options))
						: streamStockSimple(model, context, options);
				},
			});
		},
	};
}
