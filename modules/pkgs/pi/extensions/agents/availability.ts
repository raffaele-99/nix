import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const AGENTS_STATE = "pi2-agents-state";
// These can start or queue work. Observation and cancellation remain available.
export const AGENT_WORK_TOOLS = new Set(["spawn_agent", "subagent", "followup_task", "send_input", "resume_agent"]);

export function agentsEnabled(ctx: ExtensionContext): boolean {
	for (const entry of ctx.sessionManager.getBranch().toReversed()) {
		if (entry.type !== "custom" || entry.customType !== AGENTS_STATE) continue;
		const data = entry.data as { enabled?: boolean } | undefined;
		if (typeof data?.enabled === "boolean") return data.enabled;
	}
	return false;
}

export function supportsAgentToolChoice(api: string | undefined): boolean {
	return api === "openai-responses" || api === "openai-codex-responses" || api === "openai-completions";
}

export function requireAgents(ctx: ExtensionContext): void {
	if (ctx.model && !supportsAgentToolChoice(ctx.model.api)) throw new Error("Subagent toggling requires an OpenAI Responses or Chat Completions API.");
	if (!agentsEnabled(ctx)) throw new Error("Subagents are disabled. Use /agents toggle to enable them.");
}

type WireItem = Record<string, any>;
const nameOf = (tool: WireItem): string | undefined => tool.name ?? tool.function?.name ?? tool.custom?.name;

// https://developers.openai.com/api/docs/guides/function-calling#tool-choice
// Keep declarations and conversation history unchanged; constrain the next response.
export function restrictAgentTools(payload: unknown, api: string | undefined): unknown {
	if (!supportsAgentToolChoice(api) || !payload || typeof payload !== "object") return payload;
	const body = payload as WireItem;
	const choice = body.tool_choice;
	if (choice === "none") return body;
	const allowed = (tool: WireItem) => !AGENT_WORK_TOOLS.has(nameOf(tool) ?? "");
	if (choice && typeof choice === "object" && choice.type !== "allowed_tools") {
		return allowed(choice) ? body : { ...body, tool_choice: "none" };
	}
	const chat = api === "openai-completions";
	const previous = choice?.type === "allowed_tools" ? (chat ? choice.allowed_tools : choice) : undefined;
	// Native Responses builders can declare tools in input, including tool-search results.
	const declarations: WireItem[] = [...(body.tools ?? []), ...(chat || !Array.isArray(body.input) ? [] :
		body.input.flatMap((item: WireItem) => ["additional_tools", "tool_search_output"].includes(item.type) ? item.tools ?? [] : []))];
	if (!previous && declarations.every(allowed)) return body;
	const references = previous?.tools ?? declarations.map((tool) => {
		const name = nameOf(tool);
		if (tool.type === "function" || tool.type === "custom") return chat
			? { type: tool.type, [tool.type]: { name } } : { type: tool.type, name };
		if (tool.type === "mcp") return { type: "mcp", server_label: tool.server_label };
		return { type: tool.type };
	});
	const tools = [...new Map(references.filter(allowed).map((tool: WireItem) => [JSON.stringify(tool), tool])).values()];
	const mode = previous?.mode ?? (choice === "required" ? "required" : "auto");
	// Chat Completions nests the configuration; Responses places it beside `type`.
	return { ...body, tool_choice: tools.length === 0 ? "none" : chat
		? { type: "allowed_tools", allowed_tools: { mode, tools } }
		: { type: "allowed_tools", mode, tools } };
}
