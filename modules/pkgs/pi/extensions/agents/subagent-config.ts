import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ServiceTier } from "../providers/config.ts";
import type { ServiceTierResolver, StreamOverrides } from "../providers/state.ts";
import { ModelPicker } from "../providers/model-picker.ts";
import { pickOpenRouterProvider } from "../providers/openrouter/provider.ts";
import { fetchOpenRouterModels, isOpenRouterModel, openRouterModel, type OpenRouterModel } from "../providers/openrouter/catalog.ts";

export const SUBAGENT_CONFIG = "pi2-subagent-config";
export const DEFAULT_MAX_ACTIVE_SUBAGENTS = 4;
export const MAX_ACTIVE_SUBAGENTS = 32;
const FOLLOW = "Follow main thread";
const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SPEEDS: { label: string; value?: ServiceTier }[] = [
	{ label: FOLLOW },
	{ label: "Standard", value: "default" },
	{ label: "Fast (priority)", value: "priority" },
	{ label: "Ultrafast", value: "ultrafast" },
];

export interface SubagentConfig {
	maxActive?: number;
	model?: { provider: string; id: string; endpoint?: string | null; catalog?: OpenRouterModel };
	thinkingLevel?: ThinkingLevel;
	serviceTier?: ServiceTier;
	/** Per-request transport override; the label comes from the provider feature. */
	streamOverride?: boolean;
}

function validMaxActive(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_ACTIVE_SUBAGENTS;
}

// Read the active branch each time: resume, reload, fork and /tree need no cache
// invalidation, and these UI-only entries never enter the workers' context.
export function readSubagentConfig(ctx: ExtensionContext): SubagentConfig {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== SUBAGENT_CONFIG) continue;
		const data = entry.data as SubagentConfig | undefined;
		if (!data || typeof data !== "object") return {};
		return {
			...(validMaxActive(data.maxActive) ? { maxActive: data.maxActive } : {}),
			...(data.model && typeof data.model.provider === "string" && typeof data.model.id === "string"
				? { model: { provider: data.model.provider, id: data.model.id,
					...(data.model.provider === "openrouter" && (data.model.endpoint === null ||
						(typeof data.model.endpoint === "string" && data.model.endpoint.length > 0))
						? { endpoint: data.model.endpoint } : {}),
					...(data.model.provider === "openrouter" && isOpenRouterModel(data.model.catalog) && data.model.catalog.id === data.model.id
						? { catalog: structuredClone(data.model.catalog) } : {}),
				} } : {}),
			...(LEVELS.includes(data.thinkingLevel!) ? { thinkingLevel: data.thinkingLevel } : {}),
			...(SPEEDS.some((speed) => speed.value && speed.value === data.serviceTier) ? { serviceTier: data.serviceTier } : {}),
			...(typeof data.streamOverride === "boolean" ? { streamOverride: data.streamOverride } : {}),
		};
	}
	return {};
}

function configuredModel(ctx: ExtensionContext, config: SubagentConfig) {
	if (!config.model) return ctx.model;
	return ctx.modelRegistry.find(config.model.provider, config.model.id) ??
		(config.model.provider === "openrouter" && config.model.catalog ? openRouterModel(config.model.catalog) : undefined);
}

export function resolveSubagentConfig(ctx: ExtensionContext, inheritedTier?: ServiceTier,
	resolveTier?: ServiceTierResolver, streamOverrides?: StreamOverrides) {
	const config = readSubagentConfig(ctx);
	let model = configuredModel(ctx, config);
	if (!model) throw new Error(config.model
		? `Subagent model ${config.model.provider}/${config.model.id} is unavailable; choose another with /agents config`
		: "No model selected");
	if (config.model && !ctx.modelRegistry.hasConfiguredAuth(model))
		throw new Error(`No credentials for subagent model ${model.provider}/${model.id}; use /login or /agents config`);
	if (model.provider === "openrouter" && config.model?.endpoint !== undefined) {
		if (model.api !== "openai-completions") throw new Error("OpenRouter provider routing requires the openai-completions API");
		const compat = { ...model.compat } as Record<string, unknown>;
		if (config.model.endpoint === null) delete compat.openRouterRouting;
		else compat.openRouterRouting = { only: [config.model.endpoint], allow_fallbacks: false };
		model = { ...model, compat } as Model<Api>;
	}
	return {
		model,
		thinkingLevel: clampThinkingLevel(model, config.thinkingLevel ?? ctx.thinkingLevel ?? "off"),
		serviceTier: resolveTier?.(model, config.serviceTier ?? inheritedTier),
		streamOverride: streamOverrides?.resolve(model, config.streamOverride),
	};
}

export async function configureSubagents(pi: ExtensionAPI, ctx: ExtensionContext, inheritedTier?: ServiceTier,
	resolveTier?: ServiceTierResolver, streamOverrides?: StreamOverrides): Promise<boolean> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/agents config requires interactive or RPC mode.", "warning");
		return false;
	}
	let draft = readSubagentConfig(ctx);
	while (true) {
		const maxActive = draft.maxActive ?? DEFAULT_MAX_ACTIVE_SUBAGENTS;
		const maxActiveLabel = `Max active subagents: ${maxActive}`;
		const modelLabel = draft.model ? `${draft.model.provider}/${draft.model.id}` : FOLLOW;
		const speedLabel = SPEEDS.find((speed) => speed.value === draft.serviceTier)!.label;
		const model = configuredModel(ctx, draft);
		const defaultTier = model ? resolveTier?.(model, inheritedTier) : undefined;
		const overrideSupport = model ? streamOverrides?.support(model) : undefined;
		const overrideLabel = `${overrideSupport?.label ?? "Override"}: ${draft.streamOverride === undefined ? FOLLOW : draft.streamOverride ? "On" : "Off"}`;
		const providerItem = draft.model?.provider === "openrouter"
			? `OpenRouter provider: ${draft.model.endpoint ?? "Auto"}` : undefined;
		const items = [
			`Model: ${modelLabel}`,
			`Reasoning: ${draft.thinkingLevel ?? FOLLOW}`,
			`Speed: ${speedLabel}${!draft.serviceTier && defaultTier ? ` (${defaultTier})` : ""}`,
			...(providerItem ? [providerItem] : []),
			...(overrideSupport ? [overrideLabel] : []),
			maxActiveLabel,
			"Reset all to defaults", "Save", "Cancel",
		];
		const choice = await ctx.ui.select("Subagent configuration — this session", items);
		if (choice === undefined || choice === "Cancel") return false;
		if (choice === "Save") {
			pi.appendEntry(SUBAGENT_CONFIG, draft);
			ctx.ui.notify(`Subagent configuration saved: ${modelLabel}; reasoning ${draft.thinkingLevel ?? FOLLOW}; speed ${speedLabel}; max active ${maxActive}. Model settings apply to future batches. The active limit applies immediately without interrupting running workers.`, "info");
			return true;
		}
		if (choice === "Reset all to defaults") { draft = {}; continue; }
		if (choice === maxActiveLabel) {
			const values = Array.from({ length: MAX_ACTIVE_SUBAGENTS }, (_, i) => String(i + 1));
			const selected = await ctx.ui.select(`Max active subagents (1–${MAX_ACTIVE_SUBAGENTS}; default ${DEFAULT_MAX_ACTIVE_SUBAGENTS})`, values);
			if (selected !== undefined && values.includes(selected)) draft.maxActive = Number(selected);
			continue;
		}
		if (overrideSupport && choice === overrideLabel) {
			const selected = await ctx.ui.select(`Subagent ${overrideSupport.label.toLowerCase()} — supported models only`, [FOLLOW, "On", "Off"]);
			if (selected === FOLLOW) delete draft.streamOverride;
			else if (selected === "On") draft.streamOverride = true;
			else if (selected === "Off") draft.streamOverride = false;
			continue;
		}
		if (providerItem && choice === providerItem && draft.model) {
			const endpoint = await pickOpenRouterProvider(ctx, draft.model.id, draft.model.endpoint);
			if (endpoint !== undefined) draft.model = { ...draft.model, endpoint };
			continue;
		}
		if (choice === items[0]) {
			const catalog = await fetchOpenRouterModels(ctx);
			const available = ctx.modelRegistry.getAvailable();
			const known = new Set(available.map((m) => `${m.provider}/${m.id}`));
			const models = [...available, ...catalog.filter((m) => !known.has(`openrouter/${m.id}`)).map(openRouterModel)].sort((a, b) =>
				`${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
			const labels = models.map((model) => `${model.provider}/${model.id}`);
			// RPC clients cannot render custom terminal components; keep their native dialog.
			const selected = ctx.mode === "tui"
				? await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => new ModelPicker(
					[{ value: FOLLOW }, ...models.map((model, index) => ({ value: labels[index], description: model.name }))],
					modelLabel, theme, keys, () => tui.requestRender(), done,
				))
				: await ctx.ui.select("Subagent model", [FOLLOW, ...labels]);
			if (selected === FOLLOW) delete draft.model;
			else {
				const model = models[labels.indexOf(selected ?? "")];
				if (model) {
					if (model.provider === "openrouter") {
						if (model.api !== "openai-completions") {
							ctx.ui.notify("OpenRouter provider routing requires the openai-completions API", "warning");
							continue;
						}
						const endpoint = await pickOpenRouterProvider(ctx, model.id,
							draft.model?.id === model.id ? draft.model.endpoint : undefined);
						if (endpoint !== undefined) draft.model = { provider: model.provider, id: model.id, endpoint,
							...(catalog.find((m) => m.id === model.id) ? { catalog: catalog.find((m) => m.id === model.id)! } : {}),
						};
					} else draft.model = { provider: model.provider, id: model.id };
				}
			}
		} else if (choice === items[1]) {
			const model = configuredModel(ctx, draft);
			const selected = await ctx.ui.select("Subagent reasoning (clamped to model support)", [
				FOLLOW, ...(model ? getSupportedThinkingLevels(model) : LEVELS),
			]);
			if (selected === FOLLOW) delete draft.thinkingLevel;
			else if (LEVELS.includes(selected as ThinkingLevel)) draft.thinkingLevel = selected as ThinkingLevel;
		} else if (choice === items[2]) {
			const selected = await ctx.ui.select("Subagent speed — supported models only; faster tiers may cost more", SPEEDS.map((speed) => speed.label));
			const speed = SPEEDS.find((speed) => speed.label === selected);
			if (speed) {
				if (speed.value) draft.serviceTier = speed.value;
				else delete draft.serviceTier;
			}
		}
	}
}
