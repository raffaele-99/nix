import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface OpenAIState {
	ultrafast: boolean;
}

// Only session preferences are persisted, not account-wide usage/cache data.
type SavedOpenAIState = Pick<OpenAIState, "ultrafast">;
const STATE_ENTRY = "pi2-openai-state";

export function registerOpenAIState(pi: ExtensionAPI, state: OpenAIState): (changes: SavedOpenAIState) => void {
	const defaultUltrafast = state.ultrafast;
	const restore = (_event: unknown, ctx: ExtensionContext) => {
		state.ultrafast = defaultUltrafast;
		for (const entry of ctx.sessionManager.getBranch().toReversed()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			const saved = entry.data as Partial<SavedOpenAIState> | null | undefined;
			if (typeof saved?.ultrafast !== "boolean") continue;
			state.ultrafast = saved.ultrafast;
			break;
		}
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	return (changes) => {
		// Non-context entries live in the existing session file, never in chat.
		pi.appendEntry(STATE_ENTRY, changes);
		Object.assign(state, changes);
	};
}

export function createOpenAIState(): OpenAIState {
	return { ultrafast: false };
}
