import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";

const CONTROL_PATH = process.env.PI_SUBAGENT_CONTROL;
const FULL_REMOTE = process.env.PI_REMOTE_FILE_TOOLS === "1";

const MAX_CONCURRENT = 4;

const EXT_DIR = path.join(os.homedir(), ".pi", "agent", "extensions");

function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

const SUBAGENT_SYSTEM_PROMPT = [
	"You are a subagent handling a delegated task on behalf of a main agent.",
	"You run autonomously with a fresh, isolated context and cannot ask follow-up questions.",
	"Investigate and complete the task using your tools, then report your findings concisely as your final message.",
	"Other agents may be working in the same filesystem concurrently: prefer reads, and keep any writes scoped to the task you were given to avoid colliding with disjoint work.",
].join(" ");

type ActivityKind = "text" | "thinking" | "tool";

// Minimal, UI-agnostic record of a subagent's conversation, accumulated off the
// JSON event stream so it can be replayed into native chat components on attach.
// The wire format (`toJsonEvent`) strips the cumulative `partial` snapshot from
// `message_update` deltas, so we reconstruct the in-flight assistant message from
// the deltas ourselves (see `applyAssistantDelta`) to stream live, then replace
// it with the authoritative message at `message_end`.
interface SubagentTranscript {
	// Finalized assistant messages (from message_end).
	messages: any[];
	// Latest/partial result per tool call id, with a streaming flag.
	toolResults: Map<string, { result: any; isError: boolean; partial: boolean }>;
}

// Apply one stripped `assistantMessageEvent` delta to the in-flight message's
// content, mutating it in place. Content indices can arrive for text, thinking,
// or tool-call parts; gaps are filtered out at render time.
function applyAssistantDelta(message: any, ame: any): void {
	if (!ame || typeof ame.contentIndex !== "number") return;
	const idx = ame.contentIndex;
	const content: any[] = message.content ?? (message.content = []);
	switch (ame.type) {
		case "text_start":
			content[idx] = { type: "text", text: "" };
			break;
		case "text_delta":
			if (content[idx]?.type !== "text") content[idx] = { type: "text", text: "" };
			content[idx].text += ame.delta ?? "";
			break;
		case "thinking_start":
			content[idx] = { type: "thinking", thinking: "" };
			break;
		case "thinking_delta":
			if (content[idx]?.type !== "thinking") content[idx] = { type: "thinking", thinking: "" };
			content[idx].thinking += ame.delta ?? "";
			break;
		case "toolcall_start":
			// Args stream in as `toolcall_delta` JSON fragments; keep them empty until
			// `toolcall_end` delivers the parsed arguments object.
			content[idx] = { type: "toolCall", id: ame.id, name: ame.toolName, arguments: {} };
			break;
		case "toolcall_end":
			if (ame.toolCall) content[idx] = ame.toolCall;
			break;
	}
}

interface LiveSubagent {
	id: number;
	task: string;
	proc: ChildProcess;
	conn: net.Socket;
	turns: number;
	tokens: number;
	cost: number;
	lastTool?: string;
	done: boolean;
	// Live view of what the subagent is doing right now: streaming prose,
	// reasoning, or an active tool call. Updated off the JSON event stream.
	activity?: string;
	activityKind?: ActivityKind;
	// Accumulator for the in-flight text/thinking block being streamed.
	streamBuf: string;
	// Full conversation replayed into the /sa-attach overlay.
	transcript: SubagentTranscript;
	// In-flight assistant message reconstructed from deltas (undefined between turns).
	liveMessage?: any;
}

// The built-in tool renderers (shell `$ cmd`, file paths, …) aren't on the
// package's public export surface, so `ToolExecutionComponent` would fall back to
// dumping the raw argument JSON. Supply small native-style `renderCall`s for the
// tools a subagent actually uses so its transcript reads like a normal Pi chat.
// Result rendering is left to the component's default (it already shows output).
function toolCallRenderers(toolName: string): { renderCall: (args: any, theme: any, ctx: any) => Component } | undefined {
	const reuseText = (ctx: any): Text => (ctx.lastComponent as Text) ?? new Text("", 0, 0);
	const n = toolName.toLowerCase();

	if (n === "bash" || n === "command" || n === "shell" || n === "powershell") {
		const prompt = n === "powershell" ? "PS>" : "$";
		return {
			renderCall(args, theme, ctx) {
				const a = args ?? {};
				const cmd =
					typeof a.command === "string" ? a.command : typeof a.cmd === "string" ? a.cmd : "";
				const timeout =
					typeof a.timeout === "number" ? theme.fg("muted", ` (timeout ${a.timeout}s)`) : "";
				const text = reuseText(ctx);
				text.setText(theme.fg("toolTitle", theme.bold(`${prompt} ${cmd || "..."}`)) + timeout);
				return text;
			},
		};
	}

	if (["read", "write", "edit", "ls", "grep", "find", "glob"].includes(n)) {
		return {
			renderCall(args, theme, ctx) {
				const a = args ?? {};
				const target = collapseWs(
					String(a.path ?? a.file ?? a.filePath ?? a.file_path ?? a.pattern ?? a.query ?? ""),
				);
				const text = reuseText(ctx);
				text.setText(theme.fg("toolTitle", theme.bold(target ? `${toolName} ${target}` : toolName)));
				return text;
			},
		};
	}

	return undefined;
}

// Pad a (possibly ANSI-styled) line with spaces to `width` so the overlay fully
// paints over the chat beneath it instead of letting it bleed through.
function padLine(line: string, width: number): string {
	const w = visibleWidth(line);
	return w < width ? line + " ".repeat(width - w) : line;
}

// Full-screen, view-only overlay that renders a running subagent's transcript
// using the host's native chat components, following the tail like `tail -f`.
// Esc detaches. There is no scrolling by design.
class SubagentOverlay implements Component {
	private body = new Container();

	constructor(
		private tui: TUI,
		private theme: Theme,
		private sa: LiveSubagent,
		private onDetach: () => void,
	) {
		this.rebuild();
	}

	// Rebuild from the accumulated transcript. Rebuilding wholesale (rather than
	// appending) keeps the logic trivial and is cheap: subagent transcripts are
	// small and we only refresh on coarse events (message/tool completion).
	rebuild(): void {
		const md = getMarkdownTheme();
		const cwd = process.cwd();
		this.body.clear();
		this.body.addChild(new UserMessageComponent(`Task: ${this.sa.task}`, md));

		// Finalized turns, then the in-flight (streaming) message, if any.
		const messages = [...this.sa.transcript.messages];
		if (this.sa.liveMessage) messages.push(this.sa.liveMessage);

		for (const message of messages) {
			if (message.role !== "assistant") continue;
			const streaming = message === this.sa.liveMessage;
			// Drop sparse gaps left by out-of-order content indices.
			const content = (message.content ?? []).filter(Boolean);
			const hasAnything = content.some(
				(c: any) =>
					(c.type === "text" && c.text?.trim()) ||
					(c.type === "thinking" && c.thinking?.trim()) ||
					c.type === "toolCall",
			);
			if (streaming && !hasAnything) continue; // nothing to show for this turn yet

			const sanitized = { ...message, content };
			this.body.addChild(new Spacer(1));
			const amc = new AssistantMessageComponent(undefined, false, md);
			amc.updateContent(sanitized, streaming);
			this.body.addChild(amc);

			for (const part of content) {
				if (part.type !== "toolCall") continue;
				const tc = new ToolExecutionComponent(
					part.name,
					part.id,
					part.arguments,
					{},
					toolCallRenderers(part.name),
					this.tui,
					cwd,
				);
				tc.setArgsComplete();
				const res = this.sa.transcript.toolResults.get(part.id);
				if (res) {
					tc.updateResult(
						{
							content: res.result?.content ?? [],
							details: res.result?.details,
							isError: res.isError,
						},
						res.partial,
					);
				}
				this.body.addChild(tc);
			}
		}
	}

	refresh(): void {
		this.rebuild();
		this.tui.requestRender();
	}

	private renderHeader(width: number): string[] {
		const sa = this.sa;
		const title = `\u26ad subagent #${sa.id} \u00b7 ${sa.done ? "finished" : "running"} \u00b7 ${formatTokens(sa.tokens)} tok`;
		const hint = "Esc to detach";
		const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(hint) - 1);
		const bar = ` ${this.theme.fg("accent", title)}${" ".repeat(gap)}${this.theme.fg("dim", hint)}`;
		return [bar, this.theme.fg("dim", "\u2500".repeat(width))];
	}

	render(width: number): string[] {
		const cols = this.tui.terminal.columns || width;
		const rows = this.tui.terminal.rows || 24;
		const header = this.renderHeader(cols);
		// Reserve one blank row at the bottom so the tail isn't flush against the edge.
		const avail = Math.max(1, rows - header.length - 1);
		let lines = this.body.render(cols);
		if (lines.length > avail) lines = lines.slice(lines.length - avail);
		while (lines.length < avail) lines.push("");
		return [...header, ...lines, ""].map((l) => padLine(l, cols));
	}

	handleInput(data: string): void {
		// Esc detaches; ignore everything else (view-only, no scroll).
		if (matchesKey(data, "escape")) this.onDetach();
	}

	// Theme change / forced re-render: rebuild from scratch so native components
	// pick up new styling. Don't request a render here to avoid re-entrancy.
	invalidate(): void {
		this.rebuild();
	}

	dispose(): void {}
}

const collapseWs = (s: string): string => s.replace(/\s+/g, " ").trim();

// Best-effort one-liner describing a tool call from its arguments, so the tree
// shows "read src/main.rs" or "bash cargo build" rather than a bare tool name.
function summarizeToolArgs(name: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const pick = (...keys: string[]): string => {
		for (const k of keys) {
			const v = a[k];
			if (typeof v === "string" && v.trim()) return collapseWs(v);
			if (typeof v === "number") return String(v);
		}
		return "";
	};
	switch (name.toLowerCase()) {
		case "bash":
		case "command":
			return pick("command", "cmd", "script");
		case "read":
		case "write":
		case "edit":
			return pick("path", "file", "filePath", "file_path");
		case "web_search":
			return pick("query", "q");
		case "web_fetch":
			return pick("url");
		case "grep":
			return pick("pattern", "query", "regex");
		case "glob":
		case "ls":
			return pick("pattern", "glob", "path");
		default: {
			const common = pick("command", "path", "query", "pattern", "url", "file");
			if (common) return common;
			const first = Object.values(a).find((v) => typeof v === "string" && v.trim());
			return typeof first === "string" ? collapseWs(first) : "";
		}
	}
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

export default function (pi: ExtensionAPI) {
	if (!CONTROL_PATH) return;

	const live = new Map<number, LiveSubagent>();
	interface SubagentResult {
		exitCode: number;
		stopReason: string;
		aborted: boolean;
	}
	const finished = new Map<number, SubagentResult>();
	const waiters = new Map<number, net.Socket[]>();
	const MAX_FINISHED = 256;
	let nextId = 0;
	let server: net.Server | undefined;
	let lastCtx: any;
	let promptFile: string | undefined;
	// The currently attached (/sa-attach) overlay, if any. Only one at a time.
	let attached: { sa: LiveSubagent; overlay: SubagentOverlay } | undefined;

	// Accumulate the subagent's conversation for the attach overlay, streaming the
	// in-flight assistant message and tool output live. Boundary events (message or
	// tool completion) refresh immediately; high-frequency deltas are throttled.
	function captureTranscript(sa: LiveSubagent, event: any) {
		switch (event.type) {
			case "message_start":
				if (event.message?.role === "assistant") {
					if (!Array.isArray(event.message.content)) event.message.content = [];
					sa.liveMessage = event.message;
					scheduleAttachRefresh(sa);
				}
				break;
			case "message_update": {
				if (!sa.liveMessage) sa.liveMessage = { role: "assistant", content: [] };
				applyAssistantDelta(sa.liveMessage, event.assistantMessageEvent);
				scheduleAttachRefresh(sa);
				break;
			}
			case "message_end":
				if (event.message?.role === "assistant") {
					sa.transcript.messages.push(event.message);
					sa.liveMessage = undefined;
					notifyAttached(sa);
				}
				break;
			case "tool_execution_update":
				if (event.toolCallId) {
					sa.transcript.toolResults.set(event.toolCallId, {
						result: event.partialResult,
						isError: false,
						partial: true,
					});
					scheduleAttachRefresh(sa);
				}
				break;
			case "tool_execution_end":
				if (event.toolCallId) {
					sa.transcript.toolResults.set(event.toolCallId, {
						result: event.result,
						isError: !!event.isError,
						partial: false,
					});
					notifyAttached(sa);
				}
				break;
		}
	}

	function notifyAttached(sa: LiveSubagent) {
		if (attached && attached.sa === sa) attached.overlay.refresh();
	}

	// Throttle delta-driven refreshes so fast token streams don't rebuild + repaint
	// the overlay on every chunk (same 80ms cadence as the status widget).
	let attachRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let attachRefreshPending = false;
	function scheduleAttachRefresh(sa: LiveSubagent) {
		if (!attached || attached.sa !== sa) return;
		if (attachRefreshTimer) {
			attachRefreshPending = true;
			return;
		}
		attached.overlay.refresh();
		attachRefreshTimer = setTimeout(() => {
			attachRefreshTimer = undefined;
			if (attachRefreshPending) {
				attachRefreshPending = false;
				scheduleAttachRefresh(sa);
			}
		}, 80);
	}

	function recordFinished(id: number, result: SubagentResult) {
		finished.set(id, result);
		while (finished.size > MAX_FINISHED) {
			const oldest = finished.keys().next().value;
			if (oldest === undefined) break;
			finished.delete(oldest);
		}
		const pending = waiters.get(id);
		if (!pending) return;
		waiters.delete(id);
		const payload = `${JSON.stringify({ type: "subagent_end", id, ...result })}\n`;
		for (const w of pending) {
			if (!w.destroyed) {
				w.write(payload);
				w.end();
			}
		}
	}

	function handleWait(conn: net.Socket, req: any) {
		const id = typeof req.id === "number" ? req.id : Number.parseInt(String(req.id), 10);
		if (!Number.isFinite(id)) {
			conn.write(`${JSON.stringify({ type: "error", message: "invalid wait id" })}\n`);
			conn.end();
			return;
		}
		const done = finished.get(id);
		if (done) {
			conn.write(`${JSON.stringify({ type: "subagent_end", id, ...done })}\n`);
			conn.end();
			return;
		}
		if (live.has(id)) {
			const arr = waiters.get(id) ?? [];
			arr.push(conn);
			waiters.set(id, arr);
			conn.on("close", () => {
				const cur = waiters.get(id);
				if (!cur) return;
				const idx = cur.indexOf(conn);
				if (idx >= 0) cur.splice(idx, 1);
				if (cur.length === 0) waiters.delete(id);
			});
			return;
		}
		if (id < nextId) {
			conn.write(
				`${JSON.stringify({ type: "subagent_end", id, exitCode: 0, stopReason: "end", aborted: false })}\n`,
			);
			conn.end();
			return;
		}
		conn.write(`${JSON.stringify({ type: "error", message: `unknown subagent ${id}` })}\n`);
		conn.end();
	}

	function ensurePromptFile(): string {
		if (promptFile && fs.existsSync(promptFile)) return promptFile;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		promptFile = path.join(dir, "system.md");
		fs.writeFileSync(promptFile, SUBAGENT_SYSTEM_PROMPT, { encoding: "utf-8", mode: 0o600 });
		return promptFile;
	}

	// Render one subagent's live activity, coloured by kind: tool calls show the
	// tool name (accented) plus a dim argument snippet; streamed prose/reasoning
	// shows the trailing text. `avail` is the visible width left for the activity.
	function renderActivity(sa: LiveSubagent, theme: any, avail: number): string {
		const text = collapseWs(sa.activity ?? "");
		if (!text) return theme.fg("dim", "…");

		if (sa.activityKind === "tool") {
			const sp = text.indexOf(" ");
			const name = sp > 0 ? text.slice(0, sp) : text;
			const arg = sp > 0 ? text.slice(sp + 1) : "";
			if (!arg) return theme.fg("toolTitle", truncateToWidth(name, avail, "…"));
			const nameW = visibleWidth(name) + 1;
			if (nameW >= avail) return theme.fg("toolTitle", truncateToWidth(name, avail, "…"));
			const argTrunc = truncateToWidth(arg, avail - nameW, "…");
			return `${theme.fg("toolTitle", name)} ${theme.fg("dim", argTrunc)}`;
		}

		const prefix = sa.activityKind === "thinking" ? "~ " : "";
		return theme.fg("dim", truncateToWidth(prefix + text, avail, "…"));
	}

	function renderTree(running: LiveSubagent[], theme: any, width: number): string[] {
		const head = `${theme.fg("accent", "⛭")} ${theme.fg("dim", `subagents (${running.length})`)}`;
		const lines = [head];
		running.forEach((sa, i) => {
			const last = i === running.length - 1;
			const branch = last ? "└─ " : "├─ ";
			const idStr = `#${sa.id}`;
			const tokStr = formatTokens(sa.tokens).padStart(5);
			// A single leading space indents the tree under the header glyph.
			const prefixPlain = ` ${branch}${idStr} ${tokStr}  `;
			const avail = Math.max(4, width - visibleWidth(prefixPlain));
			const prefix = ` ${theme.fg("dim", branch)}${theme.fg("toolTitle", idStr)} ${theme.fg("dim", tokStr)}  `;
			lines.push(prefix + renderActivity(sa, theme, avail));
		});
		// Trailing blank line separates the tree from the working indicator below.
		lines.push("");
		return lines;
	}

	// Plain-text fallback used when the themed component factory isn't supported.
	function renderTreePlain(running: LiveSubagent[]): string[] {
		const lines = [`⛭ subagents (${running.length})`];
		running.forEach((sa, i) => {
			const branch = i === running.length - 1 ? "└─" : "├─";
			const act = collapseWs(sa.activity ?? "");
			lines.push(`${branch} #${sa.id} ${formatTokens(sa.tokens)}${act ? `  ${act}` : ""}`);
		});
		lines.push("");
		return lines;
	}

	let widgetFallback = false;

	function refreshStatus() {
		const ui = lastCtx?.ui;
		if (!ui?.setWidget) return;
		const running = [...live.values()].filter((s) => !s.done);
		if (running.length === 0) {
			ui.setWidget("subagents", undefined);
			return;
		}
		if (!widgetFallback) {
			try {
				ui.setWidget("subagents", (_tui: any, theme: any) => ({
					render(width: number): string[] {
						try {
							return renderTree(running, theme, width);
						} catch {
							return renderTreePlain(running);
						}
					},
					dispose() {},
				}));
				return;
			} catch {
				widgetFallback = true;
			}
		}
		ui.setWidget("subagents", renderTreePlain(running));
	}

	// The activity line updates on every streamed token; throttle the (relatively
	// expensive) widget rebuild so fast streams don't thrash the renderer.
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let refreshPending = false;
	function scheduleRefresh() {
		if (refreshTimer) {
			refreshPending = true;
			return;
		}
		refreshStatus();
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			if (refreshPending) {
				refreshPending = false;
				scheduleRefresh();
			}
		}, 80);
	}

	function buildSubagentArgs(task: string): string[] {
		const model = lastCtx?.model ? `${lastCtx.model.provider}/${lastCtx.model.id}` : undefined;
		const thinking = lastCtx?.thinkingLevel;

		const tools = FULL_REMOTE ? ["bash", "read", "write", "edit"] : ["Command"];
		const extensions = [path.join(EXT_DIR, "pi-remote.ts")];

		const args: string[] = ["--mode", "json", "-p", "--no-session", "--approve"];
		if (model) args.push("--model", model);
		if (thinking && thinking !== "off") args.push("--thinking", thinking);
		args.push("--no-tools", "--no-extensions");
		for (const e of extensions) args.push("-e", e);
		args.push("--tools", tools.join(","));
		args.push("--system-prompt", ensurePromptFile());
		args.push(`Task: ${task}`);
		return args;
	}

	function spawnSubagent(sa: Omit<LiveSubagent, "proc">): ChildProcess {
		const env = { ...process.env };
		delete env.PI_NOTIFY_SOCKET;
		delete env.PI_SUBAGENT_CONTROL;
		delete env.PI_SUBAGENT_SOCKET;

		const invocation = getPiInvocation(buildSubagentArgs(sa.task));
		return spawn(invocation.command, invocation.args, {
			cwd: process.cwd(),
			env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	function handleEventLine(sa: LiveSubagent, line: string) {
		if (!sa.conn.destroyed) {
			sa.conn.write(`${line}\n`);
		}
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		captureTranscript(sa, event);
		if (event.type === "message_update") {
			// Streaming deltas: reflect what the subagent is generating right now.
			const ame = event.assistantMessageEvent;
			switch (ame?.type) {
				case "text_start":
					// Reset the stream buffer but keep the last activity visible until the
					// first delta lands, so the row shows the last log instead of blanking.
					sa.streamBuf = "";
					break;
				case "text_delta":
					sa.streamBuf += ame.delta ?? "";
					sa.activityKind = "text";
					sa.activity = sa.streamBuf;
					scheduleRefresh();
					break;
				case "thinking_start":
					sa.streamBuf = "";
					break;
				case "thinking_delta":
					sa.streamBuf += ame.delta ?? "";
					sa.activityKind = "thinking";
					sa.activity = sa.streamBuf;
					scheduleRefresh();
					break;
				case "toolcall_start":
					// Args aren't known yet; show the tool name until toolcall_end.
					sa.activityKind = "tool";
					sa.lastTool = ame.toolName;
					sa.activity = ame.toolName ?? "";
					scheduleRefresh();
					break;
				case "toolcall_end": {
					const tc = ame.toolCall;
					if (tc) {
						sa.activityKind = "tool";
						sa.lastTool = tc.name;
						const arg = summarizeToolArgs(tc.name, tc.arguments);
						sa.activity = arg ? `${tc.name} ${arg}` : tc.name;
						scheduleRefresh();
					}
					break;
				}
			}
			return;
		}

		if (event.type === "message_end" && event.message?.role === "assistant") {
			sa.turns++;
			const usage = event.message.usage;
			if (usage) {
				sa.tokens += (usage.output ?? 0) + (usage.input ?? 0);
				sa.cost += usage.cost?.total ?? 0;
			}
			// Finalize activity from the authoritative message content.
			let lastText = "";
			for (const part of event.message.content ?? []) {
				if (part.type === "toolCall") {
					sa.lastTool = part.name;
					sa.activityKind = "tool";
					const arg = summarizeToolArgs(part.name, part.arguments ?? part.input);
					sa.activity = arg ? `${part.name} ${arg}` : part.name;
				} else if (part.type === "text" && typeof part.text === "string") {
					lastText = part.text;
				}
			}
			// If the turn ended on prose (no tool call), keep that text visible.
			if (sa.activityKind !== "tool" && lastText) {
				sa.activityKind = "text";
				sa.activity = lastText;
			}
			sa.streamBuf = "";
			refreshStatus();
		} else if (event.type === "tool_result_end" && event.message) {
			refreshStatus();
		}
	}

	function handleConnection(conn: net.Socket) {
		let buf = "";
		let started = false;

		const onFirstLine = (line: string) => {
			started = true;
			let req: any;
			try {
				req = JSON.parse(line);
			} catch {
				conn.write(`${JSON.stringify({ type: "error", message: "invalid request" })}\n`);
				conn.end();
				return;
			}
			if (req.type === "wait") {
				handleWait(conn, req);
				return;
			}
			if (req.type !== "run" || typeof req.task !== "string" || !req.task.trim()) {
				conn.write(`${JSON.stringify({ type: "error", message: "invalid run request" })}\n`);
				conn.end();
				return;
			}

			const runningCount = [...live.values()].filter((s) => !s.done).length;
			if (runningCount >= MAX_CONCURRENT) {
				conn.write(`${JSON.stringify({ type: "error", message: "subagent limit reached" })}\n`);
				conn.end();
				return;
			}

			const id = nextId++;
			const logPath = `/tmp/subagent-${id}.log`;
			conn.write(`${JSON.stringify({ type: "created", id, logPath })}\n`);

			const sa: LiveSubagent = {
				id,
				task: req.task,
				conn,
				turns: 0,
				tokens: 0,
				cost: 0,
				done: false,
				streamBuf: "",
				transcript: { messages: [], toolResults: new Map() },
				liveMessage: undefined,
				proc: undefined as unknown as ChildProcess,
			};
			sa.proc = spawnSubagent(sa);
			live.set(id, sa);

			refreshStatus();

			let outBuf = "";
			sa.proc.stdout?.on("data", (chunk: Buffer) => {
				outBuf += chunk.toString();
				const lines = outBuf.split("\n");
				outBuf = lines.pop() ?? "";
				for (const l of lines) if (l.trim()) handleEventLine(sa, l);
			});
			let stderr = "";
			sa.proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			const finish = (exitCode: number) => {
				if (sa.done) return;
				sa.done = true;
				if (outBuf.trim()) handleEventLine(sa, outBuf);
				const end = {
					type: "subagent_end",
					id,
					exitCode,
					stopReason: exitCode === 0 ? "end" : "error",
				};
				if (!conn.destroyed) {
					conn.write(`${JSON.stringify(end)}\n`);
					conn.end();
				}
				live.delete(id);
				recordFinished(id, { exitCode, stopReason: end.stopReason, aborted: false });
				notifyAttached(sa);
				refreshStatus();
			};

			sa.proc.on("close", (code) => finish(code ?? 0));
			sa.proc.on("error", () => {
				if (stderr.trim() && !conn.destroyed) {
					conn.write(`${JSON.stringify({ type: "error", message: stderr.trim().slice(0, 500) })}\n`);
				}
				finish(1);
			});

			conn.on("close", () => {
				if (sa.done) return;
				abortSubagent(sa);
			});
		};

		conn.on("data", (chunk: Buffer) => {
			if (started) return;
			buf += chunk.toString();
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			onFirstLine(line);
		});

		conn.on("error", () => {});
	}

	function abortSubagent(sa: LiveSubagent) {
		sa.done = true;
		live.delete(sa.id);
		recordFinished(sa.id, { exitCode: 143, stopReason: "aborted", aborted: true });
		// If the spawning tool is still connected (e.g. a /sa-cancel while it
		// runs), tell it we aborted and close the run stream so it doesn't hang.
		if (!sa.conn.destroyed) {
			try {
				sa.conn.write(
					`${JSON.stringify({ type: "subagent_end", id: sa.id, exitCode: 143, stopReason: "aborted", aborted: true })}\n`,
				);
				sa.conn.end();
			} catch {}
		}
		try {
			sa.proc.kill("SIGTERM");
		} catch {}
		setTimeout(() => {
			try {
				if (!sa.proc.killed) sa.proc.kill("SIGKILL");
			} catch {}
		}, 5000);
		notifyAttached(sa);
		refreshStatus();
	}

	function startServer() {
		if (server) return;
		try {
			fs.rmSync(CONTROL_PATH!, { force: true });
		} catch {}
		server = net.createServer(handleConnection);
		server.on("error", () => {});
		server.listen(CONTROL_PATH);
	}

	function shutdown() {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = undefined;
		}
		if (attachRefreshTimer) {
			clearTimeout(attachRefreshTimer);
			attachRefreshTimer = undefined;
		}
		for (const sa of [...live.values()]) abortSubagent(sa);
		try {
			server?.close();
		} catch {}
		server = undefined;
	}

	pi.registerCommand("sa-cancel", {
		description: "Cancel a running subagent by ID, or all subagents if no ID is given",
		getArgumentCompletions: (prefix: string) => {
			const running = [...live.values()].filter((s) => !s.done);
			return running
				.filter((s) => String(s.id).startsWith(prefix.trim()))
				.map((s) => {
					const act = collapseWs(s.activity ?? "");
					return {
						value: String(s.id),
						label: `#${s.id}`,
						description: act ? `${formatTokens(s.tokens)} · ${act}` : formatTokens(s.tokens),
					};
				});
		},
		handler: async (args: string, ctx: any) => {
			const running = [...live.values()].filter((s) => !s.done);
			const arg = args.trim();
			if (!arg) {
				if (running.length === 0) {
					ctx.ui.notify("No running subagents to cancel.", "info");
					return;
				}
				const n = running.length;
				for (const sa of running) abortSubagent(sa);
				ctx.ui.notify(`Cancelled ${n} subagent${n === 1 ? "" : "s"}.`, "info");
				return;
			}
			const id = Number.parseInt(arg, 10);
			if (!Number.isFinite(id) || String(id) !== arg) {
				ctx.ui.notify(`Invalid subagent ID: ${arg}`, "error");
				return;
			}
			const sa = live.get(id);
			if (!sa || sa.done) {
				ctx.ui.notify(`No running subagent #${id}.`, "error");
				return;
			}
			abortSubagent(sa);
			ctx.ui.notify(`Cancelled subagent #${id}.`, "info");
		},
	});

	pi.registerCommand("sa-attach", {
		description:
			"Switch the TUI into a running subagent's live transcript (tail -f, view only; Esc to detach)",
		getArgumentCompletions: (prefix: string) => {
			const running = [...live.values()].filter((s) => !s.done);
			return running
				.filter((s) => String(s.id).startsWith(prefix.trim()))
				.map((s) => {
					const act = collapseWs(s.activity ?? "");
					return {
						value: String(s.id),
						label: `#${s.id}`,
						description: act ? `${formatTokens(s.tokens)} · ${act}` : formatTokens(s.tokens),
					};
				});
		},
		handler: async (args: string, ctx: any) => {
			if (attached) {
				ctx.ui.notify("Already attached to a subagent. Press Esc to detach first.", "warning");
				return;
			}
			if (!ctx.ui?.custom) {
				ctx.ui.notify("Attaching is only available in the interactive TUI.", "error");
				return;
			}
			const running = [...live.values()].filter((s) => !s.done);
			const arg = args.trim();
			let sa: LiveSubagent | undefined;
			if (arg) {
				const id = Number.parseInt(arg, 10);
				if (!Number.isFinite(id) || String(id) !== arg) {
					ctx.ui.notify(`Invalid subagent ID: ${arg}`, "error");
					return;
				}
				sa = live.get(id);
				if (!sa || sa.done) {
					ctx.ui.notify(`No running subagent #${id}.`, "error");
					return;
				}
			} else if (running.length === 1) {
				sa = running[0];
			} else {
				ctx.ui.notify(
					running.length === 0 ? "No running subagents to attach to." : "Specify a subagent ID to attach to.",
					"info",
				);
				return;
			}
			const target = sa;
			try {
				await ctx.ui.custom(
					(tui: TUI, theme: Theme, _kb: any, done: (r: unknown) => void) => {
						const overlay = new SubagentOverlay(tui, theme, target, () => done(undefined));
						attached = { sa: target, overlay };
						return overlay;
					},
					{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
				);
			} finally {
				attached = undefined;
			}
		},
	});

	pi.on("session_start", (_event: any, ctx: any) => {
		lastCtx = ctx;
		startServer();
	});

	pi.on("agent_start", (_event: any, ctx: any) => {
		lastCtx = ctx;
	});
	pi.on("message_start", (_event: any, ctx: any) => {
		lastCtx = ctx;
	});
	pi.on("message_end", (_event: any, ctx: any) => {
		lastCtx = ctx;
	});

	try {
		pi.on("session_shutdown" as any, () => shutdown());
	} catch {}

	process.on("exit", shutdown);
	process.on("SIGTERM", () => {
		shutdown();
		process.exit(0);
	});
}
