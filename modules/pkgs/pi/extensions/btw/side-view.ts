import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { SIDE_BOUNDARY } from "./side-session.ts";
import { ThreadView, type ThreadViewActions } from "../threads/thread-view.ts";

export { isThreadToggle as isSideToggle } from "../threads/thread-view.ts";

export class SideView extends ThreadView {
	constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, session: AgentSession, actions: Omit<ThreadViewActions, "title" | "status">) {
		super(tui, theme, keys, {
			cwd: session.sessionManager.getCwd(),
			messages: () => {
				let pastBoundary = false;
				const messages: AgentMessage[] = [];
				for (const entry of session.sessionManager.getBranch()) {
					if (entry.type === "custom" && entry.customType === SIDE_BOUNDARY) pastBoundary = true;
					if (pastBoundary && entry.type === "message") messages.push(entry.message);
				}
				return messages;
			},
			streamingMessage: () => session.state.streamingMessage,
			pendingToolCalls: () => session.state.pendingToolCalls,
			resolveToolRenderer: (name) => session.extensionRunner.resolveToolRenderers(name, () => undefined),
			subscribe: (listener) => session.subscribe(listener),
		}, {
			...actions,
			title: () => `Side thread · ${session.model?.id ?? ""}`,
			status: () => session.isStreaming ? "Working" : "Ready",
		});
	}
}
