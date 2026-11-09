import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface OpenRouterModel {
	id: string;
	name: string;
	context_length?: number | null;
	pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string; [key: string]: unknown };
	architecture?: { input_modalities?: string[]; output_modalities?: string[] };
	top_provider?: { max_completion_tokens?: number | null };
	supported_parameters?: string[];
}

export function isOpenRouterModel(value: unknown): value is OpenRouterModel {
	if (!value || typeof value !== "object") return false;
	const m = value as OpenRouterModel;
	const strings = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((s) => typeof s === "string"));
	const tokens = (v: unknown) => v == null || (typeof v === "number" && Number.isFinite(v) && v > 0);
	return typeof m.id === "string" && m.id.length > 0 && typeof m.name === "string" &&
		tokens(m.context_length) && tokens(m.top_provider?.max_completion_tokens) &&
		strings(m.supported_parameters) && strings(m.architecture?.input_modalities) && strings(m.architecture?.output_modalities) &&
		(m.pricing === undefined || (m.pricing !== null && typeof m.pricing === "object" &&
			["prompt", "completion", "input_cache_read", "input_cache_write"].every((key) =>
				m.pricing![key] === undefined || typeof m.pricing![key] === "string")));
}

export function openRouterModel(m: OpenRouterModel): Model<"openai-completions"> {
	const price = (key: string) => {
		const n = Number(m.pricing?.[key] ?? 0);
		return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : 0;
	};
	return {
		type: "chat", id: m.id, name: m.name, provider: "openrouter", api: "openai-completions",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: m.supported_parameters?.includes("reasoning") ?? false,
		input: m.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
		cost: { input: price("prompt"), output: price("completion"), cacheRead: price("input_cache_read"), cacheWrite: price("input_cache_write") },
		contextWindow: m.context_length ?? 128_000, maxTokens: m.top_provider?.max_completion_tokens ?? 32_000,
		compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter", supportsStrictMode: true, sendSessionAffinityHeaders: true },
	};
}

export async function requestOpenRouterModels(signal?: AbortSignal): Promise<OpenRouterModel[]> {
	const response = await fetch("https://openrouter.ai/api/v1/models", {
		headers: { Accept: "application/json" },
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const body = await response.json();
	if (!Array.isArray(body?.data)) throw new Error("Invalid model catalog response");
	return body.data.filter(isOpenRouterModel).filter((m: OpenRouterModel) =>
		m.supported_parameters?.includes("tools") && (m.architecture?.output_modalities?.includes("text") ?? true));
}

export async function fetchOpenRouterModels(ctx: ExtensionContext): Promise<OpenRouterModel[]> {
	// Check provider credentials, including when the local catalog has no OpenRouter models.
	if (!ctx.modelRegistry.hasConfiguredAuth(openRouterModel({ id: "catalog", name: "catalog" }))) return [];
	try {
		return await requestOpenRouterModels();
	} catch (error) {
		ctx.ui.notify(`OpenRouter catalog: ${error instanceof Error ? error.message : String(error)}; using local models.`, "warning");
		return [];
	}
}
