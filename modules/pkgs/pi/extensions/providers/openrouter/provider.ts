import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelPicker } from "../model-picker.ts";

/** null explicitly selects OpenRouter's default routing; undefined cancels. */
export async function pickOpenRouterProvider(ctx: ExtensionContext, modelId: string, current?: string | null): Promise<string | null | undefined> {
	let endpoints: { tag: string; provider_name: string; quantization?: string | null; supported_parameters?: string[] }[];
	try {
		const path = modelId.split("/").map(encodeURIComponent).join("/");
		const response = await fetch(`https://openrouter.ai/api/v1/models/${path}/endpoints`, {
			headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const body = await response.json();
		if (!Array.isArray(body?.data?.endpoints)) throw new Error("Invalid endpoint response");
		endpoints = body.data.endpoints.filter((e: typeof endpoints[number]) =>
			e && typeof e.tag === "string" && e.tag.length > 0 && typeof e.provider_name === "string" &&
			(e.supported_parameters === undefined || e.supported_parameters.includes("tools")));
	} catch (error) {
		ctx.ui.notify(`OpenRouter providers: ${error instanceof Error ? error.message : String(error)}`, "error");
		return undefined;
	}
	const auto = "Auto (OpenRouter default routing)";
	const items = [{ value: auto, description: "No provider pin" },
		...[...new Map(endpoints.map((e) => [e.tag, e])).values()].map((e) => ({
			value: e.tag, description: `${e.provider_name} · ${e.quantization || "unknown quantization"}`,
		}))];
	const title = `${modelId} — OpenRouter provider`;
	const selected = ctx.mode === "tui"
		? await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => new ModelPicker(
			items, current ?? auto, theme, keys, () => tui.requestRender(), done, title,
		))
		: await ctx.ui.select(title, items.map((item) => item.value));
	return selected === auto ? null : selected;
}
