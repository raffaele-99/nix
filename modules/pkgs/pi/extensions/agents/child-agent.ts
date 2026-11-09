import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { projectSessionHistory } from "../threads/session-history.ts";

export const AGENT_TOOLS = new Set(["subagent", "spawn_agent", "send_input", "send_message", "followup_task", "wait_agent", "list_agents", "resume_agent", "interrupt_agent", "close_agent"]);

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function addUsage(total: Usage, usage: Usage): void {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += usage[key];
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost[key];
}

// A textual snapshot cannot replay an unfinished tool call (e.g. the call spawning
// this child). Projection honors compaction, context edits and the selected branch;
// custom entries, including /btw history, never enter the snapshot.
export function contextSnapshot(ctx: ExtensionContext, model = ctx.model): string {
	const messages = projectSessionHistory(ctx);
	const text = convertToLlm(messages).filter((message) => message.role !== "system").map((message) => {
		const content = typeof message.content === "string" ? message.content : message.content.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "toolCall") return `${part.name}(${JSON.stringify(part.arguments)})`;
			if (part.type === "image") return "[image omitted]";
			return ""; // Never copy private reasoning into a textual transcript.
		}).filter(Boolean).join("\n");
		return content ? `[${message.role}]\n${content}` : "";
	}).filter(Boolean).join("\n\n");
	const limit = Math.min(100_000, Math.max(4_000, Math.floor((model?.contextWindow ?? 32_000) / 2)));
	return text.length > limit ? `[Earlier context omitted]\n${text.slice(-limit)}` : text;
}

export function referenceMessage(snapshot: string): AgentMessage[] {
	return snapshot ? [{ role: "user", content: `Main conversation snapshot (reference only, not a new task):\n\n${snapshot}`, timestamp: Date.now() }] : [];
}
