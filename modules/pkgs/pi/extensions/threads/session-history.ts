import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionContext, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

type HistoryProjector = (messages: AgentMessage[], branch: SessionEntry[]) => AgentMessage[];
const projectors = new WeakMap<ExtensionContext["sessionManager"], Set<HistoryProjector>>();

// Old toggle notices must not become user messages in requests or inherited history.
export function withoutLegacyAgentNotices(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter(message => message.role !== "custom" || message.customType !== "pi2-agents-toggle");
}

// Provider adapters own their history formats. Forks/snapshots only ask for a
// readable projection, including when the source model has since changed.
export function registerHistoryProjector(manager: ExtensionContext["sessionManager"], projector: HistoryProjector): () => void {
	let registered = projectors.get(manager);
	if (!registered) { registered = new Set(); projectors.set(manager, registered); }
	const apply: HistoryProjector = (messages, branch) => projector(messages, branch);
	registered.add(apply);
	return () => { registered.delete(apply); if (!registered.size) projectors.delete(manager); };
}

export function projectSessionHistory(ctx: Pick<ExtensionContext, "sessionManager">): AgentMessage[] {
	const branch = ctx.sessionManager.getBranch();
	let messages = buildSessionContext(branch).messages;
	for (const project of projectors.get(ctx.sessionManager) ?? []) messages = project(messages, branch);
	return withoutLegacyAgentNotices(messages);
}
