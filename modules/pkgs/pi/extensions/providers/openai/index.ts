import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { streamSimple as streamStockSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { requestConfig, type ServiceTier } from "../config.ts";
import { registerOpenAICompaction, streamWithEncryptedCompaction, supportsEncryptedCompaction } from "./compaction.ts";
import { createOpenAIState, registerOpenAIState, type OpenAIState } from "./state.ts";
import type { CachedUsageWindow, ProviderConnector, ProviderUsage, StreamOverrideResolver } from "../state.ts";

interface UsageWindow { used_percent: number; limit_window_seconds: number; reset_at: number }
export interface OpenAIUsage {
	rate_limit?: { primary_window?: UsageWindow | null; secondary_window?: UsageWindow | null } | null;
	credits?: { balance?: string; unlimited?: boolean } | null;
}
function usageWindow(value: UsageWindow | null | undefined): CachedUsageWindow | undefined {
	if (!value || !Number.isFinite(value.used_percent) || !Number.isFinite(value.limit_window_seconds) ||
		value.limit_window_seconds <= 0 || !Number.isFinite(value.reset_at)) return undefined;
	return { usedPercent: value.used_percent, limitWindowSeconds: value.limit_window_seconds, resetAt: value.reset_at };
}
export function normalizeOpenAIUsage(usage: OpenAIUsage | null): ProviderUsage {
	return {
		primary: usageWindow(usage?.rate_limit?.primary_window),
		secondary: usageWindow(usage?.rate_limit?.secondary_window),
		credits: usage?.credits ? { balance: usage.credits.balance, unlimited: usage.credits.unlimited === true } : undefined,
	};
}
export async function readOpenAIUsage(): Promise<ProviderUsage> {
	const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
	const auth = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8")) as {
		tokens?: { access_token?: string; account_id?: string };
	};
	const token = auth?.tokens?.access_token;
	if (!token) throw new Error("Codex ChatGPT login is required for OpenAI usage");
	const accountId = auth.tokens?.account_id;
	const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
		headers: { authorization: `Bearer ${token}`, "user-agent": "pi2-usage-footer/1",
			...(accountId ? { "chatgpt-account-id": accountId } : {}) },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`OpenAI usage returned HTTP ${response.status}`);
	return normalizeOpenAIUsage((await response.json()) as OpenAIUsage);
}

export function resolveOpenAIServiceTier(model: Model<Api>, requested?: ServiceTier): ServiceTier | undefined {
	return supportsEncryptedCompaction(model) ? requested : undefined;
}

export function createOpenAIConnector(state: OpenAIState = createOpenAIState()): ProviderConnector {
	return {
		id: "openai", label: "OpenAI", providers: ["openai", "openai-codex"],
		readUsage: readOpenAIUsage,
		// Keep the existing history file and override; refactoring must not reset it.
		snapshotPath: () => process.env.PI2_OPENAI_USAGE_HISTORY || join(homedir(), ".pi2", "openai-usage-snapshots.json"),
		status: (model) => supportsEncryptedCompaction(model) && state.ultrafast ? ["ultrafast"] : [],
		autoCompactionLabel: (model) => supportsEncryptedCompaction(model) ? "(OpenAI auto)" : undefined,
		hideCost: () => true,
		resolveServiceTier: (model, requested) => resolveOpenAIServiceTier(model, requested ?? (state.ultrafast ? "ultrafast" : "default")),
		registerSession: registerOpenAICompaction,
		register(pi: ExtensionAPI, resolveOverride?: StreamOverrideResolver) {
			const updateState = registerOpenAIState(pi, state);
			pi.registerCommand("ultrafast", {
				description: "Toggle OpenAI ultrafast service tier for this session (/ultrafast on|off)",
				handler: async (args, ctx) => {
					const value = args.trim().toLowerCase();
					if (value !== "" && value !== "on" && value !== "off") {
						ctx.ui.notify("Usage: /ultrafast [on|off]", "warning"); return;
					}
					const enabled = value === "" ? !state.ultrafast : value === "on";
					updateState({ ultrafast: enabled });
					ctx.ui.notify(`Ultrafast ${enabled ? "enabled" : "disabled"}.`, "info");
				},
			});
			// Preserve Pi's model catalog, credentials and stock behavior unless a
			// feature overrides this request's transport.
			for (const [provider, api] of [["openai", "openai-responses"], ["openai-codex", "openai-codex-responses"]] as const) {
				pi.registerProvider(provider, {
					api,
					streamSimple: (model, context, options) => {
						const config = requestConfig(options, state);
						const override = resolveOverride?.(model, options);
						if (override) return override.streamSimple(model, context, options, config);
						return streamWithEncryptedCompaction(model, context, options,
							(model, context, options) => streamStockSimple(model, context, {
								...options,
								onPayload: async (payload, payloadModel) => {
									const next = (await options?.onPayload?.(payload, payloadModel)) ?? payload;
									if (config.serviceTier) (next as { service_tier?: string }).service_tier = config.serviceTier;
									return next;
								},
							}));
					},
				});
			}
		},
	};
}
