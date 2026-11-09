import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { defineTool, type AgentSession, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext, type SessionManager, type ToolDefinition, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { addUsage, AGENT_TOOLS, contextSnapshot, emptyUsage, referenceMessage } from "./child-agent.ts";
import type { ServiceTier } from "../providers/config.ts";
import { DEFAULT_MAX_ACTIVE_SUBAGENTS, readSubagentConfig, resolveSubagentConfig } from "./subagent-config.ts";
import { captureWorkerSession, findWorkerHistory, openWorkerSession, readWorkerHistory, WORKER_HISTORY, type WorkerHistory, type WorkerResult } from "./worker-history.ts";
import { createWorkerSession, rootExtensionPath, type WorkerSessionOptions } from "./worker-session.ts";

const MAX_PENDING = 32;
const OUTPUT_LIMIT = 8_000;
const busy = (worker: WorkerResult) => worker.status === "running" || worker.status === "queued";
export const workerSummary = (workers: WorkerResult[]) => workers.map((w) => `${w.name}: ${w.status} [${w.id.slice(0, 8)}]${w.error ? ` — ${w.error}` : ""}`).join("\n");
// Tools the root extension registers cannot load in a worker: its commands and UI
// are deliberately excluded. Offering them would fail session creation after a
// reload adds one, so filter them out here exactly as the worker loader does.
export function workerTools(tools: readonly ToolInfo[], active: ReadonlySet<string>, root = rootExtensionPath()): string[] {
	return tools.filter((tool) => !AGENT_TOOLS.has(tool.name) && tool.exposure !== "hidden" && tool.exposure !== "model-only" &&
		resolve(tool.sourceInfo?.path ?? "") !== root &&
		(active.has(tool.name) || tool.exposure === "codemode" || tool.exposure === "deferred")).map((tool) => tool.name);
}

export const workerText = (w: WorkerResult) => `## ${w.name} (${w.status})\nWorker ID: ${w.id}\n${w.error ? `${w.error}\n` : ""}${w.output.slice(0, OUTPUT_LIMIT)}${w.output.length > OUTPUT_LIMIT ? "\n[Truncated; full output is in tool details and the saved worker session.]" : ""}`;

interface Job {
	record: WorkerHistory;
	ctx: ExtensionContext;
	settings: ReturnType<typeof resolveSubagentConfig>;
	parentSettings: ReturnType<ExtensionAPI["getSettings"]>;
	tools: string[];
	systemPrompt: string;
	snapshot: string;
	controller: AbortController;
	pending: string[];
	session?: AgentSession;
	promise?: Promise<void>;
}

export class AgentController {
	private readonly pi: ExtensionAPI;
	private readonly tier: () => ServiceTier | undefined;
	private readonly options: WorkerSessionOptions;
	private readonly jobs = new Map<string, Job>();
	private readonly changed = new Set<() => void>();
	private ctx?: ExtensionContext;
	private stopping = false;
	private active = 0;
	private lastRender = 0;
	private dialogTail: Promise<unknown> = Promise.resolve();

	constructor(pi: ExtensionAPI, tier: () => ServiceTier | undefined, options: WorkerSessionOptions = {}) {
		this.pi = pi; this.tier = tier; this.options = options;
	}

	bind(ctx: ExtensionContext): void { this.ctx = ctx; }
	reopen(ctx: ExtensionContext): void { this.ctx = ctx; this.stopping = false; }
	list(): WorkerResult[] {
		if (!this.ctx) return [];
		return readWorkerHistory(this.ctx).map(({ worker }) => {
			const live = this.jobs.get(worker.id)?.record.worker;
			return structuredClone(live ?? (busy(worker) ? { ...worker, status: "interrupted" as const } : worker));
		});
	}
	// Viewing only observes the owned session/checkpoint; it must not resume a
	// worker or open a second AgentSession that could execute its tools.
	thread(target: string): { record: WorkerHistory; session?: AgentSession } {
		const record = this.resolve(target);
		const job = this.jobs.get(record.worker.id);
		return { record: !job && busy(record.worker) ? { ...record, worker: { ...record.worker, status: "interrupted" } } : record, session: job?.session };
	}
	subscribe(callback: () => void): () => void {
		this.changed.add(callback);
		return () => { this.changed.delete(callback); };
	}
	private save(record: WorkerHistory): void { this.pi.appendEntry(WORKER_HISTORY, structuredClone(record)); }
	private update(force = true): void {
		for (const callback of this.changed) callback();
		if (!force && Date.now() - this.lastRender < 100) return;
		this.lastRender = Date.now();
		const workers = this.list().filter(busy);
		this.ctx?.ui.setWidget("pi2-agents", workers.length ? workers.map((worker) => `${workerSummary([worker])}${worker.progress === "Compacting context…" ? " · Compacting context…" : ""}`) : undefined);
	}
	private resolve(target: string): WorkerHistory {
		if (!this.ctx) throw new Error("No active session");
		const named = readWorkerHistory(this.ctx).filter((r) => r.worker.name === target);
		if (named.length === 1) return this.jobs.get(named[0].worker.id)?.record ?? structuredClone(named[0]);
		const record = findWorkerHistory(this.ctx, target);
		return this.jobs.get(record.worker.id)?.record ?? structuredClone(record);
	}

	validateBatch(ctx: ExtensionContext, tasks: { name: string; task: string; resume?: string }[]): void {
		this.bind(ctx);
		if (this.stopping) throw new Error("Agents are shutting down");
		if (tasks.length + this.jobs.size > MAX_PENDING) throw new Error(`At most ${MAX_PENDING} active or queued workers are allowed`);
		resolveSubagentConfig(ctx, this.tier(), this.options.resolveServiceTier, this.options.streamOverrides);
		const seen = new Set<string>();
		for (const task of tasks) {
			if (!task.name.trim() || !task.task.trim()) throw new Error("Worker names and tasks must not be blank");
			if (!task.resume) continue;
			const id = this.resolve(task.resume).worker.id;
			if (seen.has(id)) throw new Error("A worker can only be resumed once per batch");
			if (this.jobs.has(id) && busy(this.jobs.get(id)!.record.worker)) throw new Error("Worker is already active; use send_input or followup_task");
			seen.add(id);
		}
	}

	spawn(ctx: ExtensionContext, name: string, task: string, resume?: string, fork = true): WorkerResult {
		this.bind(ctx);
		if (this.stopping) throw new Error("Agents are shutting down");
		if (!name.trim() || !task.trim()) throw new Error("Worker names and tasks must not be blank");
		if (this.jobs.size >= MAX_PENDING) throw new Error(`At most ${MAX_PENDING} active or queued workers are allowed`);
		const previous = resume ? this.resolve(resume) : undefined;
		if (previous && this.jobs.has(previous.worker.id) && busy(this.jobs.get(previous.worker.id)!.record.worker)) throw new Error("Worker is already active; use send_input or followup_task");
		const settings = resolveSubagentConfig(ctx, this.tier(), this.options.resolveServiceTier, this.options.streamOverrides);
		const record: WorkerHistory = {
			version: 1, assignment: previous?.assignment ?? task, session: previous?.session,
			mailbox: previous?.mailbox ?? [], unreportedUsage: previous?.unreportedUsage,
			settings: { provider: settings.model.provider, model: settings.model.id, thinkingLevel: settings.thinkingLevel,
				serviceTier: settings.serviceTier, streamOverride: settings.streamOverride },
			worker: { id: previous?.worker.id ?? randomUUID(), name, task, status: "queued", output: "", turns: 0, compactions: 0, usage: emptyUsage() },
		};
		const tools = workerTools(this.pi.getAllTools(), new Set(this.pi.getActiveTools()));
		const systemPrompt = `${ctx.getSystemPrompt()}\n\nYou are a delegated worker, not the main assistant. Your ID is ${record.worker.id}. Complete the assigned task and return concise findings, changed paths and tests. Other agents share the filesystem; do not overwrite their work. The inherited conversation is reference only. You may send_message to parent or another listed worker to coordinate. You cannot spawn workers. Your history is saved and may be compacted/resumed; inspect state before repeating interrupted actions.`;
		const prompt = previous && !previous.session?.leafId ? `Original assignment:\n${record.assignment}\n\nFollow-up:\n${task}` : task;
		const job: Job = { record, ctx, settings, parentSettings: structuredClone(this.pi.getSettings()), tools, systemPrompt,
			snapshot: !previous?.session?.leafId && fork ? contextSnapshot(ctx, settings.model) : "", controller: new AbortController(), pending: [prompt] };
		this.jobs.set(record.worker.id, job);
		this.save(record);
		this.update();
		// Return the ID before starting sessions or model requests.
		setImmediate(() => this.pump());
		return structuredClone(record.worker);
	}

	pump(): void {
		if (this.stopping || !this.ctx) return;
		const maxActive = readSubagentConfig(this.ctx).maxActive ?? DEFAULT_MAX_ACTIVE_SUBAGENTS;
		for (const job of this.jobs.values()) {
			if (this.active >= maxActive) break;
			if (job.promise) continue;
			this.active++;
			job.record.worker.status = "running";
			this.save(job.record);
			job.promise = this.run(job).catch((error) => {
				job.ctx.ui.notify(`Worker ${job.record.worker.name}: ${String(error)}`, "error");
			}).finally(() => { if (this.jobs.get(job.record.worker.id) === job) this.jobs.delete(job.record.worker.id); this.active--; this.update(); this.pump(); });
		}
		this.update();
	}

	private ui(job: Job): ExtensionUIContext {
		const parent = job.ctx.ui;
		const title = (text: string) => `[${job.record.worker.name}] ${text}`;
		const dialog = <T>(run: () => Promise<T>): Promise<T> => {
			const result = this.dialogTail.catch(() => {}).then(() => { job.controller.signal.throwIfAborted(); return run(); });
			this.dialogTail = result.catch(() => {}); return result;
		};
		const opts = (value?: { signal?: AbortSignal; timeout?: number }) => ({ ...value,
			signal: AbortSignal.any([job.controller.signal, ...(job.session?.agent.signal ? [job.session.agent.signal] : []), ...(value?.signal ? [value.signal] : [])]) });
		return { ...parent,
			select: (t, items, o) => dialog(() => parent.select(title(t), items, opts(o))),
			confirm: (t, message, o) => dialog(() => parent.confirm(title(t), message, opts(o))),
			input: (t, placeholder, o) => dialog(() => parent.input(title(t), placeholder, opts(o))),
			editor: (t, prefill) => dialog(() => parent.editor(title(t), prefill)),
			custom: (factory, o) => dialog(() => parent.custom(factory, o)),
			notify: (message, type) => parent.notify(title(message), type),
			setStatus: () => {}, setWidget: () => {}, setFooter: () => {}, setHeader: () => {}, setTitle: () => {},
			setEditorComponent: () => {}, getEditorComponent: () => undefined, setEditorText: () => {}, getEditorText: () => "", pasteToEditor: () => {},
			onTerminalInput: () => () => {}, addAutocompleteProvider: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {},
			setWorkingIndicator: () => {}, setHiddenThinkingLabel: () => {},
		};
	}

	private communication(id: string): ToolDefinition[] {
		return [
			defineTool({ name: "send_message", label: "Message agent", exposure: "model-only",
				description: "Send information to parent or a worker ID/name. Does not start idle workers.",
				parameters: Type.Object({ target: Type.String(), message: Type.String({ minLength: 1 }) }),
				execute: async (_call, args) => { await this.message(args.target, args.message, false, id); return { content: [{ type: "text", text: "Message delivered" }], details: {} }; },
			}),
			defineTool({ name: "list_agents", label: "List agents", exposure: "model-only", description: "List sibling workers for coordination.", parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: workerSummary(this.list()) }], details: { workers: this.list() } }),
			}),
		];
	}

	private async run(job: Job): Promise<void> {
		const { record, controller } = job;
		const worker = record.worker;
		let manager: SessionManager | undefined;
		let unsubscribe = () => {};
		let firstEntry = 0;
		let last: AssistantMessage | undefined;
		const checkpoint = () => {
			if (manager?.getSessionFile() && manager.getLeafId() !== record.session?.leafId) {
				record.session = captureWorkerSession(manager); this.save(record);
			}
		};
		try {
			manager = openWorkerSession(job.ctx, record);
			if (!manager.getEntries().length) for (const message of referenceMessage(job.snapshot)) manager.appendMessage(message as never);
			firstEntry = manager.getEntries().length;
			job.session = await createWorkerSession({ pi: { ...this.pi, getSettings: () => job.parentSettings }, ctx: job.ctx, manager,
				...job.settings, systemPrompt: job.systemPrompt, toolNames: job.tools, communicationTools: this.communication(worker.id), ui: this.ui(job), signal: controller.signal,
				onModelUsage: (usage) => { addUsage(worker.usage, usage); this.options.onWorkerUsage?.(usage); }, onCheckpoint: checkpoint }, this.options);
			const session = job.session;
			unsubscribe = session.subscribe((event) => {
				if (event.type === "turn_start" || event.type === "turn_end" || event.type === "tool_execution_start" || event.type === "compaction_end" || event.type === "entry_appended") checkpoint();
				if (event.type === "message_end" && event.message.role === "assistant") { last = event.message; worker.turns++; }
				if (event.type === "message_start" && event.message.role === "assistant") worker.progress = "";
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") { worker.progress = ((worker.progress ?? "") + event.assistantMessageEvent.delta).slice(-2_000); this.update(false); }
				if (event.type === "compaction_start") { worker.progress = "Compacting context…"; this.update(); }
				if (event.type === "compaction_end" && event.result) worker.compactions++;
			});
			this.update(); // A queued thread viewer can now attach before the first prompt.
			const abort = () => { session.clearQueue(); void session.abort(); };
			controller.signal.addEventListener("abort", abort, { once: true });
			try {
				while (job.pending.length && !controller.signal.aborted) {
					const messages = record.mailbox?.splice(0) ?? [];
					const prompt = [...messages, job.pending.shift()!].join("\n\n");
					await session.prompt(prompt, { expandPromptTemplates: false });
				}
			} finally { controller.signal.removeEventListener("abort", abort); }
			worker.output = last?.content.filter((p) => p.type === "text").map((p) => p.text).join("\n") ?? "";
			worker.error = controller.signal.aborted ? "Cancelled" : !last ? "No response received" :
				last.stopReason === "error" || last.stopReason === "aborted" ? last.errorMessage ?? last.stopReason :
				last.stopReason !== "stop" ? `Worker stopped: ${last.stopReason}` : undefined;
			worker.status = controller.signal.aborted ? "cancelled" : worker.error ? "failed" : "completed";
		} catch (error) {
			worker.error = error instanceof Error ? error.message : String(error);
			worker.status = controller.signal.aborted ? "cancelled" : "failed";
		} finally {
			try {
				if (job.session) {
					await job.session.abort();
					await job.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				}
			} finally {
				unsubscribe(); job.session?.dispose();
				if (manager) {
					record.session = captureWorkerSession(manager);
					for (const entry of manager.getEntries().slice(firstEntry)) {
						if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) addUsage(worker.usage, entry.message.usage);
					}
				}
				record.unreportedUsage ??= emptyUsage(); addUsage(record.unreportedUsage, worker.usage);
				this.save(record); this.update();
				if (!this.stopping && !controller.signal.aborted) this.pi.sendMessage({ customType: "pi2-agent-result", content: workerText(worker), display: true,
					details: { worker: structuredClone(worker) } }, { deliverAs: "steer", triggerTurn: true });
			}
		}
	}

	async message(target: string, message: string, wake: boolean, from = "parent"): Promise<WorkerResult | undefined> {
		if (!message.trim()) throw new Error("Message must not be blank");
		const text = `[Message from ${from}]\n${message}`;
		if (target === "parent") {
			if (from === "parent") throw new Error("The main thread has no parent");
			if (!this.stopping) this.pi.sendMessage({ customType: "pi2-agent-message", content: text, display: true }, { deliverAs: "steer", triggerTurn: false });
			return;
		}
		const record = this.resolve(target);
		const job = this.jobs.get(record.worker.id);
		if (job && busy(job.record.worker)) {
			if (job.controller.signal.aborted) throw new Error("Worker is stopping; wait for it before sending another task");
			if (job.session?.isStreaming) {
				if (wake) await job.session.followUp(text);
				else await job.session.steer(text);
			} else job.pending.push(text);
			return structuredClone(job.record.worker);
		}
		if (wake) return this.spawn(this.ctx!, record.worker.name, text, record.worker.id, false);
		(record.mailbox ??= []).push(text); this.save(record); this.update();
		return this.list().find((w) => w.id === record.worker.id);
	}

	async interrupt(target: string, close = false): Promise<WorkerResult> {
		const record = this.resolve(target);
		const job = this.jobs.get(record.worker.id);
		if (job) {
			job.pending.length = 0; job.controller.abort();
			if (job.promise) await job.promise;
			else { this.jobs.delete(record.worker.id); job.record.worker.status = "cancelled"; this.save(job.record); }
		}
		const saved = this.resolve(record.worker.id);
		if (close) saved.worker.status = "closed";
		saved.mailbox = []; this.save(saved); this.update(); this.pump();
		return structuredClone(saved.worker);
	}

	async stop(shutdown = false): Promise<void> {
		this.stopping = true;
		for (const job of this.jobs.values()) { job.pending.length = 0; job.controller.abort(); }
		await Promise.all([...this.jobs.values()].map(async (job) => {
			if (job.promise) await job.promise;
			else { job.record.worker.status = "cancelled"; this.save(job.record); this.jobs.delete(job.record.worker.id); }
		}));
		this.update();
		if (!shutdown) this.stopping = false;
	}

	collect(workers: WorkerResult[]): Usage {
		const usage = emptyUsage();
		for (const worker of workers) {
			const record = this.resolve(worker.id);
			if (record.unreportedUsage) { addUsage(usage, record.unreportedUsage); record.unreportedUsage = undefined; this.save(record); }
		}
		return usage;
	}

	async wait(targets: string[] | undefined, timeoutMs: number, signal?: AbortSignal): Promise<{ workers: WorkerResult[]; timed_out: boolean }> {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 3_600_000) throw new Error("timeout_ms must be between 0 and 3600000");
		const ids = targets?.length ? targets.map((id) => this.resolve(id).worker.id) : this.list().filter(busy).map((w) => w.id);
		const selected = () => this.list().filter((w) => ids.includes(w.id));
		if (!ids.length) return { workers: this.list(), timed_out: false };
		if (selected().some((w) => !busy(w))) return { workers: selected(), timed_out: false };
		const timed_out = await new Promise<boolean>((resolve, reject) => {
			const cleanup = () => { clearTimeout(timer); this.changed.delete(check); signal?.removeEventListener("abort", abort); };
			const check = () => { if (selected().some((w) => !busy(w))) { cleanup(); resolve(false); } };
			const abort = () => { cleanup(); reject(signal?.reason ?? new Error("Wait cancelled")); };
			const timer = setTimeout(() => { cleanup(); resolve(true); }, timeoutMs);
			this.changed.add(check); signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort(); else check();
		});
		return { workers: selected(), timed_out };
	}
}
