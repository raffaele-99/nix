import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	activeProvider, connectProvider, type ConnectedProvider, type ProviderConnector, type ProviderFeature,
	type ServiceTierResolver, type SessionExtensions, type StreamOverrides, type StreamOverrideOptions,
} from "./state.ts";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import providerFooter, { type ProviderFooterOptions } from "../usage/usage-footer.ts";
import { configuredUsageWindows, registerUsageTools } from "../usage/usage-tools.ts";

export interface ProviderRegistryOptions {
	usageTools?: boolean;
	footer?: ProviderFooterOptions;
}

// Composition/routing only. All provider-specific policy lives in connectors, and
// optional features are injected here rather than imported by connectors.
export class ProviderRegistry {
	readonly connected: ConnectedProvider[];
	private readonly options: ProviderRegistryOptions;
	private readonly features: readonly ProviderFeature[];

	constructor(connectors: readonly ProviderConnector[], options: ProviderRegistryOptions = {}, features: readonly ProviderFeature[] = []) {
		const ids = new Set<string>();
		const providers = new Set<string>();
		for (const connector of connectors) {
			if (ids.has(connector.id)) throw new Error(`Duplicate provider connector: ${connector.id}`);
			ids.add(connector.id);
			for (const name of connector.providers) {
				if (providers.has(name)) throw new Error(`Duplicate provider routing: ${name}`);
				providers.add(name);
			}
		}
		this.features = features;
		this.connected = connectors.map((connector) => connectProvider(connector,
			(model) => [...(this.override(connector.id, model)?.status?.(model) ?? []), ...(connector.status?.(model) ?? [])]));
		this.options = options;
	}

	forModel(model: Model<Api> | undefined): ConnectedProvider | undefined {
		return activeProvider(this.connected, model?.provider);
	}
	resolveServiceTier: ServiceTierResolver = (model, requested) => this.forModel(model)?.connector.resolveServiceTier?.(model, requested);

	private override(connector: string, model: Model<Api>, options?: StreamOverrideOptions | SimpleStreamOptions) {
		for (const feature of this.features) {
			const found = feature.override?.(connector, model, options);
			if (found) return found;
		}
		return undefined;
	}

	streamOverrides: StreamOverrides = {
		support: (model) => {
			const connector = this.forModel(model)?.connector;
			if (!connector) return undefined;
			for (const feature of this.features) {
				const found = feature.support?.(connector.id, model);
				if (found) return found;
			}
			return undefined;
		},
		resolve: (model, requested) => {
			const connector = this.forModel(model)?.connector;
			if (!connector) return undefined;
			const found = this.features.some((feature) => feature.support?.(connector.id, model));
			return found ? this.override(connector.id, model, { streamOverride: requested }) !== undefined : undefined;
		},
	};

	private resolver(connector: string) {
		return (model: Model<Api>, options?: StreamOverrideOptions | SimpleStreamOptions) => this.override(connector, model, options);
	}

	// These are session-local hooks, not root commands/transports or polling.
	// Child threads receive only their selected provider's hooks; inherited
	// history was already projected by the source session before it was copied.
	sessionExtensions: SessionExtensions = (options) => [
		...this.connected.filter((entry) => !options.model || entry.connector.providers.includes(options.model.provider)).flatMap(({ connector }) => connector.registerSession ? [
			(pi: ExtensionAPI) => connector.registerSession!(pi, options, this.resolver(connector.id)),
		] : []),
		...(this.options.usageTools ? [(pi: ExtensionAPI) => registerUsageTools(pi, this.connected)] : []),
	];

	register(pi: ExtensionAPI): void {
		for (const feature of this.features) feature.register?.(pi);
		for (const { connector } of this.connected) {
			connector.register?.(pi, this.resolver(connector.id));
			connector.registerSession?.(pi, {}, this.resolver(connector.id));
		}
		let registeredWindows: string | undefined;
		providerFooter(pi, this.connected, () => {
			if (!this.options.usageTools) return;
			const windows = configuredUsageWindows(this.connected).join(",");
			if (windows === registeredWindows) return;
			registerUsageTools(pi, this.connected);
			registeredWindows = windows;
		}, this.options.footer);
	}
}
