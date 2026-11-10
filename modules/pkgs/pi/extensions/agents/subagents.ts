import { getMarkdownTheme, type AgentToolResult, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { AgentController, workerSummary, workerText } from "./agent-controller.ts";
import type { ServiceTier } from "../providers/config.ts";
import { configureSubagents } from "./subagent-config.ts";
import type { WorkerResult } from "./worker-history.ts";
import type { WorkerSessionOptions } from "./worker-session.ts";
import { WorkerViewer } from "./worker-view.ts";
import { AGENTS_STATE, AGENT_WORK_TOOLS, agentsEnabled, requireAgents, restrictAgentTools, supportsAllowedTools } from "./availability.ts";
import { withoutLegacyAgentNotices } from "../threads/session-history.ts";

const Target = Type.String({ minLength: 1, description: "Worker ID, unique ID prefix, or unique task name" });
const Message = Type.String({ minLength: 1 });

export function registerSubagents(pi: ExtensionAPI, getServiceTier: () => ServiceTier | undefined = () => undefined, options: WorkerSessionOptions = {}): void {
	const agents = new AgentController(pi, getServiceTier, options);
	const viewer = new WorkerViewer(pi, agents);
	pi.on("before_provider_request", (event, ctx) =>
		!agentsEnabled(ctx) && supportsAllowedTools(ctx.model) ? restrictAgentTools(event.payload, ctx.model.api) : event.payload);
	// Discard notices saved by the superseded implementation without rewriting sessions.
	pi.on("context", (event) => ({ messages: withoutLegacyAgentNotices(event.messages) }));
	const result = (workers: WorkerResult[], collect = false): AgentToolResult<any> => ({
		content: [{ type: "text", text: workers.map(workerText).join("\n\n") || "No workers." }],
		details: { workers }, ...(collect ? { usage: agents.collect(workers) } : {}),
	});
	const register = (name: string, description: string, parameters: TSchema,
		run: (args: any, signal: AbortSignal | undefined, ctx: ExtensionToolContext) => Promise<AgentToolResult<any>>) => {
		pi.registerTool({ name, label: name, exposure: "model-only", executionMode: "sequential", description, parameters,
			renderCall: (_args, theme) => new Text(theme.fg("toolTitle", name), 0, 0),
			renderResult: (output, { expanded }, theme) => {
				const workers = (output.details as { workers?: WorkerResult[] } | undefined)?.workers ?? [];
				const view = new Container();
				view.addChild(new Text(workers.length ? workerSummary(workers) : output.content.filter((p) => p.type === "text").map((p) => p.text).join("\n"), 0, 0));
				if (expanded) for (const worker of workers) {
					view.addChild(new Text(theme.fg("accent", `\n${worker.name}: ${worker.task}`), 0, 0));
					view.addChild(new Markdown(worker.output || worker.progress || worker.error || "…", 0, 0, getMarkdownTheme()));
				}
				return view;
			},
			execute: async (_id, args, signal, _update, ctx) => {
				agents.bind(ctx); signal?.throwIfAborted();
				// A response already in flight may contain calls from before the toggle, and
				// providers without allowed_tools still offer these tools while disabled.
				if (AGENT_WORK_TOOLS.has(name) && !agentsEnabled(ctx)) throw new Error("Subagents are currently disabled; do this work directly with your other tools.");
				return run(args, signal, ctx);
			},
		});
	};
	register("spawn_agent", "Start an independent worker and immediately return its ID. Continue useful work in parallel; results arrive as notifications. Workers have saved sessions, compaction and independent /agents config settings. Shared filesystem: assign disjoint file ownership. Only use wait_agent when actually blocked. Workers cannot recursively spawn workers.",
		Type.Object({ task_name: Type.String({ minLength: 1, maxLength: 80 }), message: Message, fork_context: Type.Optional(Type.Boolean()) }),
		async (args, _signal, ctx) => result([agents.spawn(ctx, args.task_name, args.message, undefined, args.fork_context !== false)]));
	register("subagent", "Start a batch of background workers and immediately return their IDs (does NOT wait). Continue work while they run; completion notifications arrive automatically. Use wait_agent only when blocked. Set resume to continue a saved worker. Prefer spawn_agent for a single worker. Assign disjoint files; no recursive delegation.",
		Type.Object({ tasks: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }), task: Message, resume: Type.Optional(Target) }), { minItems: 1, maxItems: 8 }), fork_context: Type.Optional(Type.Boolean()) }),
		async (args, _signal, ctx) => {
			// Validate the full batch before creating any background work.
			agents.validateBatch(ctx, args.tasks);
			return result(args.tasks.map((task: any) => agents.spawn(ctx, task.name, task.task, task.resume, args.fork_context !== false)));
		});
	register("list_agents", "List workers and their latest results/status. Includes saved workers after restart. Does not wait or start work.", Type.Object({}), async () => result(agents.list(), true));
	register("wait_agent", "Explicitly wait for any selected worker to finish. Timeout or cancellation ends only this wait, never the workers. Results are also delivered automatically. Avoid polling: do independent work first.",
		Type.Object({ ids: Type.Optional(Type.Array(Target)), timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000 })) }),
		async (args, signal) => {
			const waited = await agents.wait(args.ids, args.timeout_ms ?? 30_000, signal);
			const output = result(waited.workers, true);
			return { ...output, content: [{ type: "text", text: `${waited.timed_out ? "Wait timed out; workers continue running.\n" : ""}${output.content.map((p) => p.type === "text" ? p.text : "").join("\n")}` }], details: { ...output.details, timed_out: waited.timed_out } };
		});
	register("send_message", "Send information to a worker's inbox without waking an idle worker. Running workers read it as steering input; use followup_task to start more work.",
		Type.Object({ target: Target, message: Message }), async (args) => result([await agents.message(args.target, args.message, false)].filter((w): w is WorkerResult => !!w)));
	register("followup_task", "Give an existing worker another task. Starts idle/completed workers from saved history; queues follow-up work for running workers.",
		Type.Object({ target: Target, message: Message }), async (args) => result([await agents.message(args.target, args.message, true)].filter((w): w is WorkerResult => !!w)));
	register("send_input", "Send instructions to a worker. By default steer ongoing work or resume an idle worker. interrupt=true stops its current work first, then starts the new instructions from saved history.",
		Type.Object({ id: Target, message: Message, interrupt: Type.Optional(Type.Boolean()) }), async (args, _signal, ctx) => {
			if (args.interrupt) await agents.interrupt(args.id);
			requireAgents(ctx);
			const running = agents.list().some((w) => (w.id.startsWith(args.id) || w.name === args.id) && (w.status === "running" || w.status === "queued"));
			return result([await agents.message(args.id, args.message, !running)].filter((w): w is WorkerResult => !!w));
		});
	register("resume_agent", "Resume a saved worker from its last checkpoint. Use message to specify follow-up work; without it, continue its unfinished assignment.",
		Type.Object({ id: Target, message: Type.Optional(Message) }), async (args) => result([await agents.message(args.id, args.message ?? "Continue the unfinished assignment from saved history. Inspect state before repeating interrupted actions.", true)].filter((w): w is WorkerResult => !!w)));
	register("interrupt_agent", "Stop a worker's current/queued work without deleting its saved history.", Type.Object({ target: Target }), async (args) => result([await agents.interrupt(args.target)], true));
	register("close_agent", "Stop a worker and mark it closed. Saved history remains available to resume_agent.", Type.Object({ id: Target }), async (args) => result([await agents.interrupt(args.id, true)], true));

	pi.registerCommand("agents", {
		description: "Show workers and enabled status; /agents toggle, view [id/name], config, cancel [id], resume <id> [message], close <id>",
		getArgumentCompletions: (prefix) => prefix.startsWith("view ") ? agents.list()
			.filter((worker) => worker.id.startsWith(prefix.slice(5)) || worker.name.startsWith(prefix.slice(5)))
			.map((worker) => ({ value: `view ${worker.id}`, label: `${worker.name}: ${worker.status} [${worker.id.slice(0, 8)}]` })) :
			["toggle", "view", "config", "cancel", "resume", "close"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			agents.bind(ctx);
			const [command, id, ...message] = args.trim().split(/\s+/);
			try {
				if (command === "toggle" && !id) {
					const enabled = !agentsEnabled(ctx);
					pi.appendEntry(AGENTS_STATE, { enabled });
					ctx.ui.notify(`Subagents ${enabled ? "enabled" : "disabled"}.${enabled ? "" : " Existing workers continue; /agents cancel stops them."}`, "info");
					return;
				}
				if (command === "view") { await viewer.open(ctx, args.trim().slice(4).trim()); return; }
				if (command === "config" && !id) {
					if (await configureSubagents(pi, ctx, getServiceTier(), options.resolveServiceTier, options.streamOverrides)) agents.pump();
					return;
				}
				if (command === "cancel" && !message.length) { if (id) await agents.interrupt(id); else await agents.stop(); }
				else if (command === "close" && id && !message.length) await agents.interrupt(id, true);
				else if (command === "resume" && id) {
					requireAgents(ctx);
					await agents.message(id, message.join(" ") || "Continue the unfinished assignment from saved history.", true);
				}
				else if (command) { ctx.ui.notify("Usage: /agents [toggle|view [id/name]|config|cancel [id]|resume <id> [message]|close <id>]", "warning"); return; }
				const workers = agents.list();
				ctx.ui.notify(`Subagents ${agentsEnabled(ctx) ? "enabled" : "disabled"}. /agents toggle to change.\n${workers.length ? `${workerSummary(workers)}\n/agents view [id/name] to view a thread.` : "No subagents have run in this session."}`, "info");
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});
	// Workers belong to the session, not the main turn. Esc/agent_settled must
	// leave them running; only explicit cancellation or session changes stop them.
	pi.on("session_start", (_event, ctx) => agents.reopen(ctx));
	pi.on("session_shutdown", async () => agents.stop(true));
	pi.on("session_before_tree", async () => agents.stop(true));
	pi.on("session_tree", (_event, ctx) => agents.reopen(ctx));
}
