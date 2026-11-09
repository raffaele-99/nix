import type { Api, AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ServiceTier, ThreadConfig } from "./config.ts";

export interface CachedUsageWindow {
	usedPercent: number;
	limitWindowSeconds: number;
	resetAt: number;
}
export interface ProviderUsageCache {
	observedAt: string;
	primary?: CachedUsageWindow;
	secondary?: CachedUsageWindow;
	credits?: { balance?: string; unlimited: boolean };
}
export type ProviderUsage = Omit<ProviderUsageCache, "observedAt">;
export interface UsageSnapshot { dateTime: string; usage: number }
export interface UsageChange {
	percentagePointsUsed: number;
	since: string;
	observedAt: string;
	elapsedSeconds?: number;
}

// A feature may replace a provider's stock transport for selected requests. The
// provider only asks whether an override applies; it never knows the feature.
export interface StreamOverrideOptions { streamOverride?: boolean }
export interface StreamOverrideSupport { label: string }
export interface ProviderStreamOverride {
	status?(model: Model<Api>): string[];
	streamSimple(model: Model<Api>, context: TranscriptContext, options: (SimpleStreamOptions & StreamOverrideOptions) | undefined, config: ThreadConfig): AssistantMessageEventStream;
}
export interface ProviderFeature {
	/** The override for one request, or undefined to use the stock transport. */
	override?(connector: string, model: Model<Api>, options?: StreamOverrideOptions | SimpleStreamOptions): ProviderStreamOverride | undefined;
	/** Whether this feature supports a per-request override for the connector. */
	support?(connector: string, model: Model<Api>): StreamOverrideSupport | undefined;
	register?(pi: ExtensionAPI): void;
}
export type StreamOverrideResolver = (model: Model<Api>, options?: StreamOverrideOptions | SimpleStreamOptions) => ProviderStreamOverride | undefined;
export interface StreamOverrides {
	support(model: Model<Api>): StreamOverrideSupport | undefined;
	resolve(model: Model<Api>, requested?: boolean): boolean | undefined;
}

// Account usage is separate from provider request settings and session history.
export interface ProviderState {
	readonly label: string;
	usageText: string;
	usageDeltaText?: string;
	usageCache?: ProviderUsageCache;
	snapshots: UsageSnapshot[];
	recentChange?: UsageChange;
}
export function createProviderState(label: string): ProviderState {
	return { label, usageText: `${label} usage…`, snapshots: [] };
}

export interface ProviderSessionOptions {
	/** The session's fixed model; child sessions receive only their provider's hooks. */
	model?: Model<Api>;
	registry?: (ctx: ExtensionContext) => ModelRegistry;
	onUsage?: (usage: Usage) => void;
}
export type SessionExtensions = (options: ProviderSessionOptions) => ExtensionFactory[];
export type ServiceTierResolver = (model: Model<Api>, requested?: ServiceTier) => ServiceTier | undefined;

export interface ProviderConnector {
	readonly id: string;
	readonly label: string;
	readonly providers: readonly string[];
	readUsage?(ctx: ExtensionContext): Promise<ProviderUsage>;
	snapshotPath?(): string;
	status?(model: Model<Api>): string[];
	autoCompactionLabel?(model: Model<Api>): string | undefined;
	hideCost?(model: Model<Api>): boolean;
	resolveServiceTier?: ServiceTierResolver;
	/** Root-only commands, preferences and transport registration. */
	register?(pi: ExtensionAPI, resolveOverride?: StreamOverrideResolver): void;
	/** Session-local hooks; also installed in workers and side sessions. */
	registerSession?(pi: ExtensionAPI, options: ProviderSessionOptions, resolveOverride?: StreamOverrideResolver): void;
}
export interface ConnectedProvider {
	connector: ProviderConnector;
	state: ProviderState;
	/** Connector status with any feature-provided status in front. */
	status?(model: Model<Api>): string[];
}
export function connectProvider(connector: ProviderConnector, status?: (model: Model<Api>) => string[]): ConnectedProvider {
	return { connector, state: createProviderState(connector.label), ...(status ? { status } : {}) };
}
export function activeProvider(connected: readonly ConnectedProvider[], provider: string | undefined): ConnectedProvider | undefined {
	return provider === undefined ? undefined : connected.find((entry) => entry.connector.providers.includes(provider));
}
