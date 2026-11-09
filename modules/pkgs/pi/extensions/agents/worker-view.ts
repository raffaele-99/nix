import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type OverlayHandle } from "@earendil-works/pi-tui";
import { AgentController } from "./agent-controller.ts";
import { threadSwitcher } from "../threads/thread-switcher.ts";
import { ThreadView, type ThreadViewEvent, type ThreadViewSource, type ThreadViewState } from "../threads/thread-view.ts";
import { readWorkerBranch, type WorkerHistory, type WorkerResult } from "./worker-history.ts";

const activeWorker = (worker: WorkerResult) => worker.status === "queued" || worker.status === "running";

// A stable source across queued -> live -> saved (and resumed) worker sessions.
// Saved history is read directly, never resumed just to display a transcript.
class WorkerThread implements ThreadViewSource {
	readonly cwd: string;
	record: WorkerHistory;
	private session?: AgentSession;
	private savedMessages: AgentMessage[] = [];
	private savedKey?: string;
	private readonly listeners = new Set<(event: ThreadViewEvent) => void>();
	private unsubscribeSession = () => {};
	private unsubscribeController = () => {};

	constructor(agents: AgentController, target: string, ctx: ExtensionContext, onError: (error: unknown) => void) {
		this.cwd = ctx.cwd;
		this.record = agents.thread(target).record;
		const id = this.record.worker.id;
		const refresh = () => {
			const { record, session } = agents.thread(id);
			const savedKey = JSON.stringify([record.session?.path, record.session?.leafId]);
			const reset = session !== this.session || (!session && savedKey !== this.savedKey);
			this.record = record;
			if (reset) {
				const messages = session ? [] : readWorkerBranch(ctx, record.session)
					.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
				this.unsubscribeSession();
				this.session = session;
				this.savedKey = savedKey;
				this.savedMessages = messages;
				this.unsubscribeSession = session?.subscribe((event) => this.emit(event)) ?? (() => {});
			}
			this.emit({ type: reset ? "thread_reset" : "thread_status" });
		};
		refresh();
		this.unsubscribeController = agents.subscribe(() => {
			try { refresh(); } catch (error) { onError(error); }
		});
	}

	messages(): AgentMessage[] {
		const messages = this.session ? this.session.sessionManager.getBranch()
			.flatMap((entry) => entry.type === "message" ? [entry.message] : []) : this.savedMessages;
		return messages.length || this.session ? messages : [{ role: "user", content: this.record.worker.task, timestamp: 0 }];
	}
	streamingMessage() { return this.session?.state.streamingMessage; }
	pendingToolCalls() { return this.session?.state.pendingToolCalls ?? new Set<string>(); }
	resolveToolRenderer(name: string) { return this.session?.extensionRunner.resolveToolRenderers(name, () => undefined); }
	get model(): string { return this.session?.model?.id ?? this.record.settings?.model ?? ""; }
	subscribe(listener: (event: ThreadViewEvent) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}
	private emit(event: ThreadViewEvent): void { for (const listener of this.listeners) listener(event); }
	dispose(): void { this.unsubscribeSession(); this.unsubscribeController(); this.listeners.clear(); }
}

export class WorkerViewer {
	private readonly pi: ExtensionAPI;
	private readonly agents: AgentController;
	private ctx?: ExtensionContext;
	private thread?: WorkerThread;
	private overlay?: OverlayHandle;
	private view?: ThreadView;
	private readonly viewStates = new Map<string, ThreadViewState>();
	private visible = false;
	private dialogs = 0;
	private generation = 0;
	private render = () => {};

	constructor(pi: ExtensionAPI, agents: AgentController) {
		this.pi = pi;
		this.agents = agents;
		threadSwitcher(pi).register("worker", {
			list: (ctx) => { agents.bind(ctx); return agents.list().filter(activeWorker).map((worker) => worker.id); },
			hide: () => this.setVisible(false),
			blocked: () => this.dialogs > 0,
			show: (id, ctx, stillCurrent) => {
				if (stillCurrent() && activeWorker(agents.thread(id).record.worker)) return this.open(ctx, id);
			},
		});
		pi.on("ui_prompt_start", () => { this.dialogs++; this.overlay?.setHidden(true); });
		pi.on("ui_prompt_end", () => { this.dialogs = Math.max(0, this.dialogs - 1); this.setVisible(this.visible); });
		pi.on("agent_start", () => this.render());
		pi.on("agent_settled", () => this.render());
		pi.on("session_shutdown", () => this.close());
		pi.on("session_before_tree", () => this.close());
		pi.on("session_start", () => this.close());
	}

	private setVisible(value: boolean): void {
		this.visible = value;
		if (value && this.thread) threadSwitcher(this.pi).activate("worker", this.thread.record.worker.id);
		this.overlay?.setHidden(!value || this.dialogs > 0);
		if (value && !this.dialogs) this.overlay?.focus();
		this.render();
	}

	close(): void {
		this.unmount();
		this.viewStates.clear();
	}

	private unmount(): void {
		this.generation++;
		this.visible = false;
		if (this.thread && this.view) this.viewStates.set(this.thread.record.worker.id, this.view.getState());
		if (this.ctx) {
			threadSwitcher(this.pi).release("worker");
			this.ctx.ui.setWidget("pi2-worker-view", undefined);
		}
		this.thread?.dispose();
		this.thread = undefined;
		this.ctx = undefined;
	}

	async open(ctx: ExtensionContext, target = ""): Promise<void> {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			ctx.ui.notify("/agents view requires interactive mode; use /agents to list workers.", "warning");
			return;
		}
		const token = ++this.generation;
		if (!target) {
			const workers = this.agents.list();
			if (!workers.length) { ctx.ui.notify("No subagents have run in this session.", "info"); return; }
			const labels = workers.map((worker) => `${worker.name}: ${worker.status} [${worker.id}]`);
			const wasVisible = this.visible;
			this.setVisible(false);
			const selected = await ctx.ui.select("View subagent thread", labels);
			if (token !== this.generation) return;
			if (!selected) { this.setVisible(wasVisible); return; }
			target = workers[labels.indexOf(selected)]?.id ?? "";
			if (!target) return;
		}
		const { record } = this.agents.thread(target);
		if (this.thread?.record.worker.id === record.worker.id) { this.setVisible(true); return; }
		const thread = new WorkerThread(this.agents, target, ctx, (error) => {
			ctx.ui.notify(`Worker thread: ${error instanceof Error ? error.message : String(error)}`, "error");
			this.close();
		});
		this.unmount();
		this.ctx = ctx;
		this.thread = thread;
		const switcher = threadSwitcher(this.pi);
		switcher.activate("worker", record.worker.id);
		// Like /btw, a zero-height widget owns a non-blocking overlay. ui.custom
		// would keep the main session waiting for input and mask permission events.
		ctx.ui.setWidget("pi2-worker-view", (tui, theme) => {
			const view = this.view = new ThreadView(tui, theme, getKeybindings(), thread, {
				title: () => `Subagent ${thread.record.worker.name} [${thread.record.worker.id.slice(0, 8)}] · ${thread.model}`,
				status: () => `${thread.record.worker.status}${thread.record.worker.error ? `: ${thread.record.worker.error}` : ""} · Read-only`,
				next: () => { void switcher.cycle(ctx); }, main: () => switcher.main(), close: () => this.unmount(),
				mainStatus: () => this.dialogs ? "needs input" : ctx.isIdle() ? "idle" : "working",
			}, this.viewStates.get(record.worker.id));
			this.render = () => tui.requestRender();
			this.overlay = tui.showOverlay(view, { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 });
			this.setVisible(true);
			return {
				render: () => [], invalidate: () => view.invalidate(),
				dispose: () => {
					this.overlay?.hide(); view.dispose(); thread.dispose();
					this.overlay = undefined; this.view = undefined; this.render = () => {};
				},
			};
		}, { placement: "belowEditor" });
	}
}
