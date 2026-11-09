import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent, getSelectListTheme, ToolExecutionComponent, UserMessageComponent,
	type AgentSessionEvent, type Theme, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Container, Editor, matchesKey, Spacer, Text, truncateToWidth, visibleWidth, type Component, type Focusable, type KeybindingsManager, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";

export function isThreadToggle(data: string): boolean {
	// Legacy terminals encode Ctrl+/, Ctrl+7 and Ctrl+_ as the same byte.
	return data === "\x1f" || matchesKey(data, "ctrl+/") || matchesKey(data, "ctrl+7");
}

export type ThreadViewEvent = AgentSessionEvent | { type: "thread_reset" | "thread_status" };

export interface ThreadViewSource {
	cwd: string;
	messages(): AgentMessage[];
	streamingMessage?(): AgentMessage | undefined;
	pendingToolCalls?(): ReadonlySet<string>;
	resolveToolRenderer?(name: string): ToolRenderers | undefined;
	isRunning?(): boolean;
	subscribe(listener: (event: ThreadViewEvent) => void): () => void;
}

export interface ThreadViewActions {
	title(): string;
	status(): string;
	submit?(text: string): void;
	next(): void;
	main(): void;
	close(): void;
	abort?(): void;
	mainStatus(): string;
}

export interface ThreadViewState {
	expanded: boolean;
	thinking: boolean;
	scrollBack: number;
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string" ? message.content : message.content
		.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

// Laid out like the main chat so transcript renderers such as gradient-tools.ts
// apply; they read this thread's tool expansion and run state instead of the main's.
class Transcript extends Container {
	toolsExpanded = false;
	running = false;
}

// Shared full-screen transcript for side conversations and read-only workers.
// It observes a source; it never owns or stops the underlying AgentSession.
export class ThreadView implements Component, Focusable {
	private readonly editor?: Editor;
	private hasFocus = false;
	private readonly transcript = new Transcript();
	private firstVisibleLine = 0;
	private renderRequested = false;
	private readonly tools = new Map<string, ToolExecutionComponent>();
	private readonly assistants: AssistantMessageComponent[] = [];
	private currentAssistant?: AssistantMessageComponent;
	private expanded = false;
	private thinking = false;
	private scrollBack = 0;
	private viewportHeight = 1;
	private cachedLines?: { width: number; lines: string[] };
	private unsubscribe: () => void;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly source: ThreadViewSource;
	private readonly actions: ThreadViewActions;

	constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, source: ThreadViewSource, actions: ThreadViewActions, state?: ThreadViewState) {
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.source = source;
		this.actions = actions;
		if (state) { this.expanded = state.expanded; this.thinking = state.thinking; this.scrollBack = state.scrollBack; }
		if (actions.submit) {
			const editor = this.editor = new Editor(tui, { borderColor: (text) => theme.fg("borderAccent", text), selectList: getSelectListTheme() });
			editor.onSubmit = (text) => {
				if (!text.trim()) return;
				editor.addToHistory(text);
				editor.setText("");
				this.scrollBack = 0;
				actions.submit!(text);
			};
		}
		this.restoreSource();
		this.unsubscribe = source.subscribe((event) => this.onEvent(event));
	}

	getState(): ThreadViewState { return { expanded: this.expanded, thinking: this.thinking, scrollBack: this.scrollBack }; }
	getDraft(): string { return this.editor?.getText() ?? ""; }
	setDraft(text: string): void { this.editor?.setText(text); this.tui.requestRender(); }

	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) { this.hasFocus = value; if (this.editor) this.editor.focused = value; }

	private restoreSource(): void {
		this.transcript.clear();
		this.tools.clear();
		this.assistants.length = 0;
		this.currentAssistant = undefined;
		for (const message of this.source.messages()) this.restore(message);
		const streaming = this.source.streamingMessage?.();
		if (streaming?.role === "assistant") {
			this.currentAssistant = this.assistant(streaming);
			this.currentAssistant.updateContent(streaming, true);
		}
		for (const id of this.source.pendingToolCalls?.() ?? []) this.tools.get(id)?.markExecutionStarted();
	}

	private tool(id: string, name: string, args: unknown): ToolExecutionComponent {
		let component = this.tools.get(id);
		if (component) return component;
		const renderer = this.source.resolveToolRenderer?.(name);
		component = new ToolExecutionComponent(name, id, args, { showImages: false }, renderer, this.tui, this.source.cwd);
		component.setExpanded(this.expanded);
		this.tools.set(id, component);
		this.transcript.addChild(component);
		return component;
	}

	private assistant(message: AssistantMessage): AssistantMessageComponent {
		const component = new AssistantMessageComponent(message, !this.thinking);
		this.assistants.push(component);
		this.transcript.addChild(component);
		return component;
	}

	private user(message: AgentMessage): void {
		if (this.transcript.children.length > 0) this.transcript.addChild(new Spacer(1));
		this.transcript.addChild(new UserMessageComponent(messageText(message)));
	}

	private finishAssistant(message: AssistantMessage): void {
		(this.currentAssistant ?? this.assistant(message)).updateContent(message, false);
		this.currentAssistant = undefined;
		for (const part of message.content) if (part.type === "toolCall") this.tool(part.id, part.name, part.arguments).setArgsComplete();
		if (message.errorMessage) this.transcript.addChild(new Text(this.theme.fg("error", message.errorMessage), 1, 0));
	}

	private restore(message: AgentMessage): void {
		if (message.role === "user") this.user(message);
		else if (message.role === "assistant") this.finishAssistant(message);
		else if (message.role === "toolResult") this.tool(message.toolCallId, message.toolName, {}).updateResult(message);
	}

	// Sources stream while this view is hidden. A hidden overlay never renders, so
	// one outstanding request is enough; showing the overlay renders it again.
	private requestRender(): void {
		if (this.renderRequested) return;
		this.renderRequested = true;
		this.tui.requestRender();
	}

	private onEvent(event: ThreadViewEvent): void {
		if (event.type === "thread_status") { this.requestRender(); return; }
		if (event.type === "thread_reset") this.restoreSource();
		else if (event.type === "message_start") {
			if (event.message.role === "user") this.user(event.message);
			if (event.message.role === "assistant") this.currentAssistant = this.assistant(event.message);
		} else if (event.type === "message_update" && event.message.role === "assistant") {
			this.currentAssistant?.updateContent(event.message, true);
		} else if (event.type === "message_end") {
			if (event.message.role === "assistant") this.finishAssistant(event.message);
			if (event.message.role === "toolResult") this.tool(event.message.toolCallId, event.message.toolName, {}).updateResult(event.message);
		} else if (event.type === "tool_execution_start") {
			const tool = this.tool(event.toolCallId, event.toolName, event.args);
			tool.updateArgs(event.args);
			tool.markExecutionStarted();
		} else if (event.type === "tool_execution_update") {
			this.tools.get(event.toolCallId)?.updateResult({ ...event.partialResult, isError: false }, true);
		} else if (event.type === "tool_execution_end") {
			this.tools.get(event.toolCallId)?.updateResult({ ...event.result, isError: event.isError });
		}
		this.cachedLines = undefined;
		this.requestRender();
	}

	handleInput(data: string): void {
		if (isThreadToggle(data)) { this.actions.next(); return; }
		if (this.keys.matches(data, "app.interrupt")) { (this.actions.abort ?? this.actions.main)(); return; }
		if (this.keys.matches(data, "app.clear")) {
			if (this.editor?.getText()) this.editor.setText("");
			else this.actions.close();
		} else if (matchesKey(data, "pageUp")) this.scrollBack += this.viewportHeight;
		else if (matchesKey(data, "pageDown")) this.scrollBack = Math.max(0, this.scrollBack - this.viewportHeight);
		else if (matchesKey(data, "ctrl+home")) this.scrollBack = Number.MAX_SAFE_INTEGER;
		else if (matchesKey(data, "ctrl+end")) this.scrollBack = 0;
		else if (this.keys.matches(data, "app.tools.expand")) {
			this.expanded = !this.expanded;
			for (const tool of this.tools.values()) tool.setExpanded(this.expanded);
			this.cachedLines = undefined;
		} else if (this.keys.matches(data, "app.thinking.toggle")) {
			this.thinking = !this.thinking;
			for (const assistant of this.assistants) assistant.setHideThinkingBlock(!this.thinking);
			this.cachedLines = undefined;
		} else this.editor?.handleInput(data);
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent) {
		if (event.type === "click") return this.click(event);
		if (event.type !== "wheel") return undefined;
		this.scrollBack = Math.max(0, this.scrollBack - (event.wheelDelta ?? 0));
		this.tui.requestRender();
		return { handled: true };
	}

	private click(event: TuiMouseEvent) {
		const rendered = this.cachedLines;
		const headerRows = 1;
		const row = this.firstVisibleLine + event.y - headerRows;
		if (!rendered || event.y < headerRows || event.y >= headerRows + this.viewportHeight || row >= rendered.lines.length) return undefined;
		const result = this.transcript.handleMouse({ ...event, y: row, width: rendered.width, height: rendered.lines.length });
		if (result) {
			this.cachedLines = undefined;
			this.tui.requestRender();
		}
		return result;
	}

	render(width: number): string[] {
		this.renderRequested = false;
		const height = Math.max(3, this.tui.terminal.rows);
		const editor = this.editor?.render(width).slice(-(height - 2)) ?? [];
		this.viewportHeight = Math.max(0, height - editor.length - 2);
		this.transcript.toolsExpanded = this.expanded;
		this.transcript.running = this.source.isRunning?.() ?? false;
		if (!this.cachedLines || this.cachedLines.width !== width) {
			this.cachedLines = { width, lines: this.transcript.render(width) };
		}
		const lines = this.cachedLines.lines;
		this.scrollBack = Math.min(this.scrollBack, Math.max(0, lines.length - this.viewportHeight));
		const end = Math.max(0, lines.length - this.scrollBack);
		this.firstVisibleLine = Math.max(0, end - this.viewportHeight);
		const visible = lines.slice(this.firstVisibleLine, end);
		while (visible.length < this.viewportHeight) visible.push("");
		const header = this.theme.fg("accent", `${this.actions.title()} · Main ${this.actions.mainStatus()}`);
		const footer = this.theme.fg("dim", `${this.actions.status()} · Ctrl+/ next · Esc ${this.actions.abort ? "stop" : "main"} · Ctrl+C close · PgUp/PgDn scroll · Ctrl+O tools`);
		return [header, ...visible, ...editor, footer].map((line) => {
			const clipped = truncateToWidth(line, width, "");
			return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
		});
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.editor?.invalidate();
		this.transcript.invalidate();
	}
	dispose(): void { this.unsubscribe(); }
}
