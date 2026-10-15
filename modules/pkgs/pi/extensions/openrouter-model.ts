/**
 * OpenRouter Model
 *
 * /or-model [query] picks an OpenRouter model from the live OpenRouter catalog,
 * then lists that model's endpoints so a provider and quantization can be
 * pinned for the current session:
 *
 *   1. model    fuzzy search over tool-capable OpenRouter models
 *   2. quant    Tab cycles a quantization filter over the endpoint list
 *   3. provider pick one endpoint, or the first row to allow every endpoint
 *               that matches the filter
 *
 * Pins are sent through pi's compat.openRouterRouting (the same field a
 * models.json modelOverride sets) using OpenRouter's full endpoint slug, such
 * as "deepinfra/fp8" or "fireworks/us", so exactly that endpoint serves the
 * request. Each pin is stored in the session and reapplied whenever that model
 * is selected again, including from /model, Ctrl+P and resume.
 *
 * Pi handles /model before extension commands, so this cannot replace it.
 */

import type { Api, Model, OpenRouterRouting } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const PROVIDER = "openrouter";
const API_BASE_URL = "https://openrouter.ai/api/v1";
const ENTRY_TYPE = "openrouter-route";
const STATUS_KEY = "openrouter-route";
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_VISIBLE_ROWS = 12;
const MAX_LABEL_WIDTH = 44;
const ALL_QUANTS = "all";
const MODEL_PAGE = "https://openrouter.ai/";
const USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
const CONTEXT_TOKENS = 100_000;
const EMPIRICAL_INPUT_TOKENS = 32_350;
const EMPIRICAL_OUTPUT_TOKENS = 25_030;
const EMPIRICAL_CALLS = 31;
const GROWTH_PER_CALL = (EMPIRICAL_INPUT_TOKENS + EMPIRICAL_OUTPUT_TOKENS) / EMPIRICAL_CALLS;
const INPUT_SHARE = EMPIRICAL_INPUT_TOKENS / (EMPIRICAL_INPUT_TOKENS + EMPIRICAL_OUTPUT_TOKENS);
const MIN_QUANT_BITS = 8;

type ScrapedEndpoint = Record<string, any>;

type OpenRouterModel = {
	id: string;
	name: string;
	context_length: number | null;
	pricing?: Record<string, string | undefined>;
	architecture?: { input_modalities?: string[]; output_modalities?: string[] };
	top_provider?: { max_completion_tokens?: number | null };
	supported_parameters?: string[];
};

type OpenRouterEndpoint = {
	provider_name: string;
	tag: string;
	quantization: string | null;
	context_length: number | null;
	pricing?: Record<string, string | undefined>;
	supported_parameters?: string[];
	status: number;
	uptime_last_30m: number | null;
};

/** A session pin. `routing` undefined means OpenRouter's default routing. */
type Route = {
	routing?: OpenRouterRouting;
	label: string;
};

type RouteEntry = Route & { modelId: string };

type PickerItem<T> = {
	value: T;
	label: string;
	detail?: string;
	note?: string;
	current?: boolean;
	highlight?: boolean;
	search: string;
};

type PickerSpec<T> = {
	title: string;
	subtitle?: string;
	/** Tab cycles these. The items callback receives the active one. */
	filters?: string[];
	items: (filter: string | undefined) => PickerItem<T>[];
	query?: string;
	hint: string;
};

type PickerResult<T> = { value: T; query: string } | { value?: undefined; query: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

async function fetchOpenRouter<T>(path: string, signal: AbortSignal): Promise<T> {
	const response = await fetch(`${API_BASE_URL}${path}`, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
	});
	if (!response.ok) throw new Error(`GET ${path} returned HTTP ${response.status}`);
	const body: unknown = await response.json();
	if (!isRecord(body) || body.data === undefined) throw new Error(`GET ${path} returned no data`);
	return body.data as T;
}

function modelPath(id: string): string {
	return id.split("/").map(encodeURIComponent).join("/");
}

function perMillion(price: string | undefined): number {
	const value = Number(price ?? 0);
	return Number.isFinite(value) ? value * 1_000_000 : 0;
}

function formatPrice(pricing: Record<string, string | undefined> | undefined): string {
	const format = (value: number) => (value === 0 ? "0" : value >= 100 ? value.toFixed(0) : value.toFixed(2));
	return `$${format(perMillion(pricing?.prompt))}/${format(perMillion(pricing?.completion))}`;
}

function formatTokens(tokens: number | null | undefined): string {
	if (!tokens) return "?";
	if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
	return `${Math.round(tokens / 1000)}K`;
}

/** Pad every cell except the last so rows line up in a monospace list. */
function columns(rows: string[][]): string[] {
	const widths: number[] = [];
	for (const row of rows) {
		row.forEach((cell, index) => {
			widths[index] = Math.max(widths[index] ?? 0, visibleWidth(cell));
		});
	}
	return rows.map((row) =>
		row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0))).join("  "),
	);
}

function quantBits(quant: unknown): number | null {
	if (typeof quant !== "string" || quant.length === 0) return null;
	const match = /^(?:fp|bf|int)(\d+)/.exec(quant.toLowerCase());
	return match ? Number(match[1]) : null;
}

function estimatedCost(inputPerM: number, outputPerM: number, cacheReadPerM: number): number {
	const turns = CONTEXT_TOKENS / GROWTH_PER_CALL;
	const cacheTokens = (CONTEXT_TOKENS * (turns - 1)) / 2;
	const inputTokens = INPUT_SHARE * CONTEXT_TOKENS;
	const outputTokens = (1 - INPUT_SHARE) * CONTEXT_TOKENS;
	const cachePrice = cacheReadPerM || inputPerM;
	return (cachePrice * cacheTokens + inputPerM * inputTokens + outputPerM * outputTokens) / 1e6;
}

function matchBracket(text: string, start: number): string {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
		} else if (char === '"') {
			inString = true;
		} else if (char === "[") {
			depth++;
		} else if (char === "]") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	throw new Error("unbalanced brackets while parsing flight payload");
}

function flightPayload(html: string): string {
	let flight = "";
	for (const match of html.matchAll(/self\.__next_f\.push\(\[1,("[\s\S]*?")\]\)/g)) {
		try {
			flight += JSON.parse(match[1]);
		} catch {}
	}
	return flight;
}

function findStatsArray(flight: string): ScrapedEndpoint[] | null {
	const anchor = flight.indexOf('"stats":{"endpoint_id"');
	if (anchor === -1) return null;
	const keyIndex = flight.lastIndexOf('"state":{"data":[', anchor);
	if (keyIndex === -1) return null;
	const array = JSON.parse(matchBracket(flight, flight.indexOf("[", keyIndex)));
	const first = Array.isArray(array) ? array[0] : undefined;
	return isRecord(first) && "data_policy" in first && "stats" in first ? (array as ScrapedEndpoint[]) : null;
}

function extractEndpoints(html: string, model: string): ScrapedEndpoint[] {
	const flight = flightPayload(html);
	const stats = findStatsArray(flight);
	if (stats) return stats;

	const keyIndex = flight.indexOf('"variantGroups":');
	if (keyIndex === -1) throw new Error(`no endpoint data found for ${model}`);
	const groups = JSON.parse(matchBracket(flight, flight.indexOf("[", keyIndex))) as ScrapedEndpoint[];
	const standard = groups.find((group) => group.variant === "standard");
	if (!standard) throw new Error(`no standard variant group for ${model}`);
	return standard.endpoints as ScrapedEndpoint[];
}

function rankCleanEndpoints(endpoints: ScrapedEndpoint[]): string[] {
	const ranked: { tag: string; cost: number }[] = [];
	for (const endpoint of endpoints) {
		if ((quantBits(endpoint.quantization) ?? 0) < MIN_QUANT_BITS) continue;

		const policy = (endpoint.data_policy ?? {}) as { training?: unknown; retainsPrompts?: unknown };
		if (policy.training || policy.retainsPrompts) continue;

		if (typeof endpoint.provider_slug !== "string" || !endpoint.provider_slug) continue;
		const pricing = endpoint.pricing as Record<string, string | undefined> | undefined;
		const cost = estimatedCost(
			perMillion(pricing?.prompt),
			perMillion(pricing?.completion),
			perMillion(pricing?.input_cache_read),
		);
		ranked.push({ tag: endpoint.provider_slug, cost });
	}
	return ranked.sort((a, b) => a.cost - b.cost).map((row) => row.tag);
}

async function fetchCleanEndpoints(model: string, signal: AbortSignal): Promise<string[]> {
	const response = await fetch(`${MODEL_PAGE}${modelPath(model)}`, {
		headers: { "user-agent": USER_AGENT },
		signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
	});
	if (!response.ok) throw new Error(`OpenRouter model page returned HTTP ${response.status}`);
	return rankCleanEndpoints(extractEndpoints(await response.text(), model));
}

function getRouting(model: Model<Api> | undefined): OpenRouterRouting | undefined {
	const compat = model?.compat;
	return isRecord(compat) && isRecord(compat.openRouterRouting)
		? (compat.openRouterRouting as OpenRouterRouting)
		: undefined;
}

function sameRouting(left: OpenRouterRouting | undefined, right: OpenRouterRouting | undefined): boolean {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sameEndpoints(routing: OpenRouterRouting | undefined, tags: string[]): boolean {
	const only = routing?.only;
	return !!only && only.length === tags.length && tags.every((tag) => only.includes(tag));
}

function withRoute(model: Model<Api>, route: Route): Model<Api> {
	const compat: Record<string, unknown> = { ...(model.compat ?? {}) };
	if (route.routing) compat.openRouterRouting = route.routing;
	else delete compat.openRouterRouting;
	return { ...model, compat } as Model<Api>;
}

/** Pi's model store usually already has every model; this covers ones released since its last refresh. */
function fallbackModel(model: OpenRouterModel): Model<"openai-completions"> {
	return {
		type: "chat",
		id: model.id,
		name: model.name,
		api: "openai-completions",
		provider: PROVIDER,
		baseUrl: API_BASE_URL,
		reasoning: model.supported_parameters?.includes("reasoning") ?? false,
		input: model.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
		cost: {
			input: perMillion(model.pricing?.prompt),
			output: perMillion(model.pricing?.completion),
			cacheRead: perMillion(model.pricing?.input_cache_read),
			cacheWrite: perMillion(model.pricing?.input_cache_write),
		},
		contextWindow: model.context_length ?? 128_000,
		maxTokens: model.top_provider?.max_completion_tokens ?? 32_000,
		compat: {
			supportsDeveloperRole: false,
			thinkingFormat: "openrouter",
			supportsStrictMode: true,
			sendSessionAffinityHeaders: true,
		},
	};
}

class Picker<T> implements Component, Focusable {
	private readonly input = new Input();
	private readonly border: DynamicBorder;
	private filterIndex = 0;
	private items: PickerItem<T>[] = [];
	private visible: PickerItem<T>[] = [];
	private selected = 0;
	private isFocused = false;

	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		this.isFocused = value;
		this.input.focused = value;
	}

	constructor(
		private readonly spec: PickerSpec<T>,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: (result: PickerResult<T>) => void,
	) {
		this.border = new DynamicBorder((text) => theme.fg("border", text));
		this.input.setValue(spec.query ?? "");
		this.reload();
	}

	private reload(): void {
		this.items = this.spec.items(this.spec.filters?.[this.filterIndex]);
		this.applyQuery();
	}

	private applyQuery(): void {
		const query = this.input.getValue().trim();
		this.visible = query ? fuzzyFilter(this.items, query, (item) => item.search) : this.items;
		const current = query ? -1 : this.visible.findIndex((item) => item.current);
		this.selected = Math.max(0, current);
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		const filters = this.spec.filters ?? [];
		if (keybindings.matches(data, "tui.input.tab") && filters.length > 1) {
			this.filterIndex = (this.filterIndex + 1) % filters.length;
			this.reload();
		} else if (keybindings.matches(data, "tui.select.up")) {
			if (this.visible.length) this.selected = (this.selected - 1 + this.visible.length) % this.visible.length;
		} else if (keybindings.matches(data, "tui.select.down")) {
			if (this.visible.length) this.selected = (this.selected + 1) % this.visible.length;
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			const item = this.visible[this.selected];
			if (item) this.done({ value: item.value, query: this.input.getValue() });
		} else if (keybindings.matches(data, "tui.select.cancel")) {
			this.done({ query: this.input.getValue() });
		} else {
			const before = this.input.getValue();
			this.input.handleInput(data);
			if (this.input.getValue() !== before) this.applyQuery();
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const lines = [...this.border.render(width), theme.fg("accent", theme.bold(this.spec.title))];
		if (this.spec.subtitle) lines.push(theme.fg("muted", this.spec.subtitle));

		const filters = this.spec.filters ?? [];
		if (filters.length > 1) {
			const active = filters[this.filterIndex];
			const chips = filters.map((filter) =>
				filter === active ? theme.fg("accent", theme.bold(`[${filter}]`)) : theme.fg("muted", filter),
			);
			lines.push(`${theme.fg("muted", "quant ")}${chips.join(" ")}`);
		}
		lines.push("", ...this.input.render(width), "");

		const labelWidth = Math.min(
			MAX_LABEL_WIDTH,
			Math.max(0, ...this.visible.map((item) => visibleWidth(item.label))),
		);
		const start = Math.max(
			0,
			Math.min(this.selected - Math.floor(MAX_VISIBLE_ROWS / 2), this.visible.length - MAX_VISIBLE_ROWS),
		);
		const end = Math.min(start + MAX_VISIBLE_ROWS, this.visible.length);
		for (let index = start; index < end; index++) {
			const item = this.visible[index];
			const isSelected = index === this.selected;
			const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
			const marker = item.current ? theme.fg("success", "✓ ") : "  ";
			const label = truncateToWidth(item.label, labelWidth, "…", true);
			const detail = item.detail ? `  ${theme.fg("muted", item.detail)}` : "";
			const note = item.note ? `  ${theme.fg("warning", item.note)}` : "";
			lines.push(`${cursor}${marker}${isSelected ? theme.fg("accent", label) : item.highlight ? theme.fg("success", label) : label}${detail}${note}`);
		}
		if (this.visible.length === 0) lines.push(theme.fg("muted", "  No matches"));
		else if (start > 0 || end < this.visible.length) {
			lines.push(theme.fg("dim", `  (${this.selected + 1}/${this.visible.length})`));
		}

		lines.push("", theme.fg("dim", this.spec.hint), ...this.border.render(width));
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.input.invalidate();
		this.border.invalidate();
	}
}

function pick<T>(ctx: ExtensionContext, spec: PickerSpec<T>): Promise<PickerResult<T>> {
	return ctx.ui.custom<PickerResult<T>>((tui, theme, _keybindings, done) => new Picker(spec, tui, theme, done));
}

/** Run a request behind a cancellable spinner. Resolves undefined when cancelled or failed. */
async function load<T>(
	ctx: ExtensionContext,
	message: string,
	task: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
	let failure: unknown;
	const result = await ctx.ui.custom<T | undefined>((tui, theme, _keybindings, done) => {
		let settled = false;
		const finish = (value: T | undefined) => {
			if (settled) return;
			settled = true;
			done(value);
		};
		const loader = new BorderedLoader(tui, theme, message);
		loader.onAbort = () => finish(undefined);
		task(loader.signal).then(finish, (error: unknown) => {
			failure = error;
			finish(undefined);
		});
		return loader;
	});
	if (failure && !isAbortError(failure)) {
		ctx.ui.notify(`OpenRouter: ${failure instanceof Error ? failure.message : String(failure)}`, "error");
	}
	return result;
}

export default function (pi: ExtensionAPI) {
	const routes = new Map<string, Route>();
	let modelCache: { fetchedAt: number; models: OpenRouterModel[] } | undefined;

	const loadRoutes = (ctx: ExtensionContext) => {
		routes.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !isRecord(entry.data)) continue;
			const data = entry.data as RouteEntry;
			if (typeof data.modelId === "string") routes.set(data.modelId, { routing: data.routing, label: data.label });
		}
	};

	const updateStatus = (ctx: ExtensionContext, model: Model<Api> | undefined) => {
		const only = model?.provider === PROVIDER ? getRouting(model)?.only : undefined;
		const label = model && only?.length ? (routes.get(model.id)?.label ?? only.join(", ")) : undefined;
		ctx.ui.setStatus(STATUS_KEY, label ? `openrouter: ${label}` : undefined);
	};

	// Selecting a model through /model, cycling or resume yields the catalog
	// version, so reattach this session's pin. Pi skips model_select when only
	// the model object changes, so the nested setModel does not re-enter here.
	const applyRoute = async (ctx: ExtensionContext, model: Model<Api> | undefined) => {
		const route = model?.provider === PROVIDER ? routes.get(model.id) : undefined;
		if (model && route && !sameRouting(getRouting(model), route.routing)) {
			const routed = withRoute(model, route);
			await pi.setModel(routed);
			updateStatus(ctx, routed);
			return;
		}
		updateStatus(ctx, model);
	};

	const restore = async (ctx: ExtensionContext) => {
		loadRoutes(ctx);
		await applyRoute(ctx, ctx.model);
	};

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("model_select", async (event, ctx) => applyRoute(ctx, event.model));

	const fetchModels = async (ctx: ExtensionContext): Promise<OpenRouterModel[] | undefined> => {
		if (modelCache && Date.now() - modelCache.fetchedAt < MODEL_CACHE_TTL_MS) return modelCache.models;
		const models = await load(ctx, "Fetching OpenRouter models…", (signal) =>
			fetchOpenRouter<OpenRouterModel[]>("/models", signal),
		);
		if (!models) return;
		// Pi needs tool calling, so hide models without it.
		const usable = models.filter(
			(model) =>
				model.supported_parameters?.includes("tools") &&
				(model.architecture?.output_modalities?.includes("text") ?? true),
		);
		modelCache = { fetchedAt: Date.now(), models: usable };
		return usable;
	};

	const pickModel = (ctx: ExtensionContext, models: OpenRouterModel[], query: string) => {
		const current = ctx.model?.provider === PROVIDER ? ctx.model.id : undefined;
		const details = columns(models.map((model) => [formatTokens(model.context_length), formatPrice(model.pricing)]));
		const items = models.map<PickerItem<OpenRouterModel>>((model, index) => ({
			value: model,
			label: model.id,
			detail: details[index],
			note: ctx.modelRegistry.find(PROVIDER, model.id) ? undefined : "not in pi's catalog",
			current: model.id === current,
			search: `${model.id} ${model.name}`,
		}));
		return pick(ctx, {
			title: "OpenRouter model",
			subtitle: "context · $ per 1M input/output tokens",
			items: () => items,
			query,
			hint: "type to search · ↑↓ move · enter providers · esc cancel",
		});
	};

	const pickEndpoint = (
		ctx: ExtensionContext,
		model: OpenRouterModel,
		endpoints: OpenRouterEndpoint[],
		cleanTags: string[],
	) => {
		const isCurrentModel = ctx.model?.provider === PROVIDER && ctx.model.id === model.id;
		const currentRouting = isCurrentModel ? getRouting(ctx.model) : undefined;
		const quantOf = (endpoint: OpenRouterEndpoint) => endpoint.quantization || "unknown";
		const supportsTools = (endpoint: OpenRouterEndpoint) => endpoint.supported_parameters?.includes("tools") ?? true;
		const clean = new Set(cleanTags);

		// Clean endpoints first, then usable ones, then cheapest input price.
		const sorted = [...endpoints].sort(
			(left, right) =>
				Number(clean.has(right.tag)) - Number(clean.has(left.tag)) ||
				Number(supportsTools(right)) - Number(supportsTools(left)) ||
				Number(right.status >= 0) - Number(left.status >= 0) ||
				perMillion(left.pricing?.prompt) - perMillion(right.pricing?.prompt),
		);
		const counts = new Map<string, number>();
		for (const endpoint of sorted) counts.set(quantOf(endpoint), (counts.get(quantOf(endpoint)) ?? 0) + 1);
		const quants = [...counts.entries()]
			.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
			.map(([quant]) => quant);

		const endpointCells = (endpoint: OpenRouterEndpoint) => [
			endpoint.tag,
			quantOf(endpoint),
			formatPrice(endpoint.pricing),
			formatTokens(endpoint.context_length),
			endpoint.uptime_last_30m === null ? "up ?" : `up ${Math.floor(endpoint.uptime_last_30m)}%`,
		];
		const bestEndpoint = cleanTags
			.map((tag) => sorted.find((endpoint) => endpoint.tag === tag))
			.find((endpoint) => endpoint && supportsTools(endpoint));
		const isPinnedTo = (endpoint: OpenRouterEndpoint) =>
			isCurrentModel && sameEndpoints(currentRouting, [endpoint.tag]);
		const endpointItem = (endpoint: OpenRouterEndpoint, detail: string | undefined): PickerItem<Route> => ({
			value: { routing: { only: [endpoint.tag], allow_fallbacks: false }, label: endpoint.tag },
			label: endpoint.provider_name,
			detail,
			note:
				[!supportsTools(endpoint) && "no tools", endpoint.status < 0 && "degraded"].filter(Boolean).join(", ") ||
				undefined,
			current: endpoint !== bestEndpoint && isPinnedTo(endpoint),
			highlight: clean.has(endpoint.tag),
			search: `${endpoint.provider_name} ${endpoint.tag} ${quantOf(endpoint)}`,
		});

		const items = (filter: string | undefined): PickerItem<Route>[] => {
			const quant = filter && filter !== ALL_QUANTS ? filter : undefined;
			const matching = quant ? sorted.filter((endpoint) => quantOf(endpoint) === quant) : sorted;
			const tags = matching.map((endpoint) => endpoint.tag);
			const any: PickerItem<Route> = quant
				? {
						value: { routing: { only: tags }, label: `any ${quant} (${tags.length})` },
						label: `any ${quant} provider`,
						detail: `${tags.length} endpoints, OpenRouter balances between them`,
						current: isCurrentModel && sameEndpoints(currentRouting, tags),
						search: `any ${quant}`,
					}
				: {
						value: { label: "auto" },
						label: "auto",
						detail: "no pin, OpenRouter's default routing",
						current: isCurrentModel && !currentRouting?.only?.length,
						search: "auto any",
					};
			const shown = bestEndpoint ? [bestEndpoint, ...matching] : matching;
			const details = columns(shown.map(endpointCells));
			const endpointItems = shown.map((endpoint, index) => endpointItem(endpoint, details[index]));
			if (!bestEndpoint) return [any, ...endpointItems];

			const [bestItem, ...rest] = endpointItems;
			const best: PickerItem<Route> = {
				...bestItem,
				label: `best: ${bestEndpoint.provider_name}`,
				current: isPinnedTo(bestEndpoint),
				search: `best ${bestItem.search}`,
			};
			return [best, any, ...rest];
		};

		return pick(ctx, {
			title: `${model.id} providers`,
			subtitle: "endpoint · quant · $ per 1M input/output · context · uptime (30m) · green: fp8+, no training or retention",
			filters: [ALL_QUANTS, ...quants],
			items,
			hint: "type to search · ↑↓ move · tab quant · enter pin · esc back",
		});
	};

	const selectRoute = async (ctx: ExtensionContext, picked: OpenRouterModel, route: Route) => {
		const routed = withRoute(ctx.modelRegistry.find(PROVIDER, picked.id) ?? fallbackModel(picked), route);
		// Register the route before switching so model_select sees it as already applied.
		const previous = routes.get(picked.id);
		routes.set(picked.id, route);

		let failure: string | undefined;
		try {
			if (!(await pi.setModel(routed))) {
				failure = "OpenRouter is not authenticated. Run /login or set OPENROUTER_API_KEY.";
			}
		} catch (error) {
			failure = `OpenRouter: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (failure) {
			if (previous) routes.set(picked.id, previous);
			else routes.delete(picked.id);
			ctx.ui.notify(failure, "error");
			return;
		}

		pi.appendEntry<RouteEntry>(ENTRY_TYPE, { modelId: picked.id, ...route });
		updateStatus(ctx, routed);
		ctx.ui.notify(`${picked.id} → ${route.label}`, "info");
		if (route.routing && routed.api !== "openai-completions") {
			ctx.ui.notify(
				`Pi sends ${picked.id} through ${routed.api}, which ignores OpenRouter provider routing.`,
				"warning",
			);
		}
	};

	pi.registerCommand("or-model", {
		description: "Pick an OpenRouter model, then pin its provider and quantization",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/or-model needs the interactive terminal UI", "error");
				return;
			}

			const models = await fetchModels(ctx);
			if (!models) return;

			let query = args.trim();
			for (;;) {
				const modelChoice = await pickModel(ctx, models, query);
				query = modelChoice.query;
				const picked = modelChoice.value;
				if (!picked) return;

				const loaded = await load(ctx, `Fetching ${picked.id} providers…`, (signal) =>
					Promise.all([
						fetchOpenRouter<{ endpoints?: OpenRouterEndpoint[] }>(
							`/models/${modelPath(picked.id)}/endpoints`,
							signal,
						),
						fetchCleanEndpoints(picked.id, signal).catch((error: unknown) => {
							if (!isAbortError(error)) {
								const message = error instanceof Error ? error.message : String(error);
								ctx.ui.notify(`OpenRouter best provider: ${message}`, "warning");
							}
							return [];
						}),
					]),
				);
				const [details, cleanTags = []] = loaded ?? [];
				const endpoints = details?.endpoints ?? [];
				if (details && endpoints.length === 0) ctx.ui.notify(`${picked.id} has no live endpoints`, "warning");
				if (endpoints.length === 0) continue;

				// Duplicate tags are separate deployments behind the same slug, so one row covers them.
				const unique = [...new Map(endpoints.map((endpoint) => [endpoint.tag, endpoint])).values()];
				const routeChoice = await pickEndpoint(ctx, picked, unique, cleanTags);
				if (!routeChoice.value) continue;

				await selectRoute(ctx, picked, routeChoice.value);
				return;
			}
		},
	});
}
