import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { activeProvider, type CachedUsageWindow, type ConnectedProvider, type ProviderState, type ProviderUsageCache } from "../providers/state.ts";
import { roundPercent } from "./usage-format.ts";

const STALE_AFTER_MS = 15 * 60_000;
const noParameters = Type.Object({});
const WINDOWS = ["primary", "secondary"] as const;
type UsageWindowName = typeof WINDOWS[number];

function result(value: Record<string, unknown>, isError = false) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: value,
		...(isError ? { isError: true } : {}),
	};
}

type UsageResult = ReturnType<typeof result>;

function cachedUsage(state: ProviderState): ProviderUsageCache | string {
	const cache = state.usageCache;
	if (!cache) return `${state.label} usage cache is unavailable`;
	const age = Date.now() - Date.parse(cache.observedAt);
	if (!Number.isFinite(age) || age > STALE_AFTER_MS) return `${state.label} usage cache is stale; observed at ${cache.observedAt}`;
	return cache;
}

function cachedError(state: ProviderState, message: string) {
	return result({ provider: state.label, error: message, observedAt: state.usageCache?.observedAt }, true);
}

export function configuredUsageWindows(connected: readonly ConnectedProvider[]): UsageWindowName[] {
	return WINDOWS.filter((window) => connected.some((entry) => entry.state.usageCache?.[window]));
}

export function registerUsageTools(pi: ExtensionAPI, connected: readonly ConnectedProvider[]): void {
	// Models call windows that appear in the schema even when they don't exist, so list only cached ones.
	const configuredWindows = configuredUsageWindows(connected);
	const firstWindow = configuredWindows[0];
	const windowParameters = Type.Object({
		window: Type.Optional(firstWindow === undefined ? Type.Never()
			: configuredWindows.length === 1 ? Type.Literal(firstWindow)
			: Type.Union(configuredWindows.map((window) => Type.Literal(window)))),
	});
	const selected = (ctx: ExtensionContext) => activeProvider(connected, ctx.model?.provider)?.state;
	const noProvider = (ctx: ExtensionContext) => result({
		error: `No usage data is available for provider ${ctx.model?.provider ?? "(none)"}`,
	}, true);
	const withCache = (ctx: ExtensionContext, read: (state: ProviderState, cache: ProviderUsageCache) => UsageResult): UsageResult => {
		const state = selected(ctx);
		if (!state) return noProvider(ctx);
		const cache = cachedUsage(state);
		return typeof cache === "string" ? cachedError(state, cache) : read(state, cache);
	};
	const withWindow = (
		ctx: ExtensionContext,
		requested: UsageWindowName | undefined,
		read: (window: CachedUsageWindow) => Record<string, unknown>,
	): UsageResult => withCache(ctx, (state, cache) => {
		const name = requested ?? WINDOWS.find((window) => cache[window]) ?? "primary";
		const window = cache[name];
		return window
			? result({ provider: state.label, ...read(window), observedAt: cache.observedAt })
			: cachedError(state, `No ${name} rate-limit window is cached`);
	});

	pi.registerTool({
		name: "get_remaining_usage",
		label: "Remaining usage",
		description: "Read cached account-wide percentage remaining for one rate-limit window of the selected model's provider.",
		parameters: windowParameters,
		async execute(_id, params, _signal, _update, ctx) {
			return withWindow(ctx, params.window, (window) => ({
				remainingPercent: roundPercent(100 - window.usedPercent),
				windowSeconds: window.limitWindowSeconds,
			}));
		},
	});

	pi.registerTool({
		name: "time_to_next_reset",
		label: "Next usage reset",
		description: "Read the cached reset time for one rate-limit window of the selected model's provider.",
		parameters: windowParameters,
		async execute(_id, params, _signal, _update, ctx) {
			return withWindow(ctx, params.window, (window) => ({
				resetAt: new Date(window.resetAt * 1000).toISOString(),
				secondsRemaining: Math.max(0, Math.ceil(window.resetAt - Date.now() / 1000)),
			}));
		},
	});

	pi.registerTool({
		name: "get_recent_usage_change",
		label: "Recent usage change",
		description: "Read the selected model provider's cached account-wide percentage-point usage change since the previous snapshot.",
		parameters: noParameters,
		async execute(_id, _params, _signal, _update, ctx) {
			return withCache(ctx, (state) => state.recentChange
				? result({ provider: state.label, ...state.recentChange })
				: cachedError(state, "No prior usage snapshot is available"));
		},
	});

	pi.registerTool({
		name: "get_usage_snapshots",
		label: "Usage snapshots",
		description: "Read the selected model provider's cached weekly-used-percent snapshots, oldest first. Usage is account-wide.",
		parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 96 })) }),
		async execute(_id, params, _signal, _update, ctx) {
			const state = selected(ctx);
			if (!state) return noProvider(ctx);
			const limit = Math.min(96, Math.max(1, params.limit ?? 12));
			return result({ provider: state.label, snapshots: state.snapshots.slice(-limit).map((snapshot) => ({ ...snapshot })) });
		},
	});

	pi.registerTool({
		name: "get_remaining_credits",
		label: "Remaining credits",
		description: "Read the selected model provider's cached credit balance without account identifiers.",
		parameters: noParameters,
		async execute(_id, _params, _signal, _update, ctx) {
			return withCache(ctx, (state, cache) => cache.credits
				? result({ provider: state.label, ...cache.credits, observedAt: cache.observedAt })
				: cachedError(state, "No credit information is cached"));
		},
	});
}
