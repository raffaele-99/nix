import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CachedUsageWindow, ProviderConnector, ProviderUsage } from "../state.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const WEEK_SECONDS = 7 * 24 * 3600;
const FIVE_HOURS_SECONDS = 5 * 3600;

interface AnthropicWindow {
	utilization?: number | null;
	resets_at?: string | null;
}

export interface AnthropicUsage {
	five_hour?: AnthropicWindow | null;
	seven_day?: AnthropicWindow | null;
}

function usageWindow(value: AnthropicWindow | null | undefined, limitWindowSeconds: number): CachedUsageWindow | undefined {
	if (typeof value?.utilization !== "number" || !Number.isFinite(value.utilization) || typeof value.resets_at !== "string") return undefined;
	const resetMs = Date.parse(value.resets_at);
	if (!Number.isFinite(resetMs)) return undefined;
	return { usedPercent: value.utilization, limitWindowSeconds, resetAt: resetMs / 1000 };
}

// Weekly is primary so the footer's reset countdown is the weekly one, as with OpenAI.
export function normalizeAnthropicUsage(usage: AnthropicUsage | null): ProviderUsage {
	return {
		primary: usageWindow(usage?.seven_day, WEEK_SECONDS),
		secondary: usageWindow(usage?.five_hour, FIVE_HOURS_SECONDS),
	};
}

export async function readAnthropicUsage(ctx: ExtensionContext): Promise<ProviderUsage> {
	// Only subscription OAuth tokens (sk-ant-oat…) can read plan usage. API keys can't.
	const token = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
	if (!token?.includes("sk-ant-oat")) throw new Error("A Claude subscription login is required for Anthropic usage");
	const response = await fetch(USAGE_URL, {
		headers: {
			authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
			accept: "application/json",
			"user-agent": "pi2-usage-footer/1",
		},
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`Anthropic usage returned HTTP ${response.status}`);
	return normalizeAnthropicUsage((await response.json()) as AnthropicUsage);
}

export function registerAnthropicSession(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.model?.provider !== "anthropic") return;
		const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
		if (event.systemPrompt.split("\n", 1)[0] === identity) return;
		return { systemPrompt: `${identity}\n${event.systemPrompt}` };
	});
}

export const anthropicConnector: ProviderConnector = {
	id: "anthropic",
	label: "Anthropic",
	providers: ["anthropic"],
	readUsage: readAnthropicUsage,
	registerSession: registerAnthropicSession,
};
