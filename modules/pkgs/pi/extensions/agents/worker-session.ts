import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collapseSystemMessages, type Api, type Model, type Usage } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
	DefaultResourceLoader, getAgentDir, ModelRuntime, SettingsManager,
	type AgentSession, type ExtensionAPI, type ExtensionContext, type ExtensionFactory,
	type ExtensionUIContext, type SessionManager, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ServiceTier } from "../providers/config.ts";
import type { ServiceTierResolver, SessionExtensions, StreamOverrides } from "../providers/state.ts";

export interface WorkerSessionOptions {
	// SDK hosts must supply their inline tool/permission extensions here too.
	extensionFactories?: ExtensionFactory[];
	extensionPaths?: string[];
	sessionExtensions?: SessionExtensions;
	resolveServiceTier?: ServiceTierResolver;
	streamOverrides?: StreamOverrides;
	/** Observe worker usage as it occurs, independently of later result collection. */
	onWorkerUsage?: (usage: Usage) => void;
}
export interface WorkerSessionRequest {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	manager: SessionManager;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	serviceTier?: ServiceTier;
	streamOverride?: boolean;
	systemPrompt: string;
	toolNames: string[];
	communicationTools: ToolDefinition[];
	ui: ExtensionUIContext;
	signal: AbortSignal;
	onModelUsage: (usage: Usage) => void;
	onCheckpoint: () => void;
}

// The pi2 root extension owns the main-thread commands and UI. Workers exclude it
// and receive its tools through extensionFactories instead, so its tools must not
// be offered to a worker unless a host supplies them.
export function rootExtensionPath(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts");
}

function cliExtensions(): string[] {
	const paths: string[] = [];
	for (let i = 2; i < process.argv.length; i++) {
		const arg = process.argv[i];
		if ((arg === "--extension" || arg === "-e") && process.argv[i + 1]) paths.push(process.argv[++i]);
		else if (arg.startsWith("--extension=")) paths.push(arg.slice("--extension=".length));
	}
	return paths;
}

export async function createWorkerSession(request: WorkerSessionRequest, options: WorkerSessionOptions = {}): Promise<AgentSession> {
	const { pi, ctx, model, manager, signal } = request;
	signal.throwIfAborted();
	const settings = SettingsManager.inMemory({ ...pi.getSettings(), cacheWarming: "off" });
	settings.setProjectTrusted(ctx.isProjectTrusted());
	const ownExtension = rootExtensionPath();
	const allowed = new Set([...request.toolNames, ...request.communicationTools.map((tool) => tool.name)]);
	const guard: ExtensionFactory = (child) => {
		child.on("tool_call", (event) => {
			if (!allowed.has(event.toolName)) return { block: true, reason: `Tool ${event.toolName} is not allowed in this worker` };
		});
	};
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd, agentDir: getAgentDir(), settingsManager: settings,
		noExtensions: options.extensionPaths !== undefined || process.argv.includes("--no-extensions"),
		additionalExtensionPaths: options.extensionPaths ?? cliExtensions(),
		noContextFiles: true, systemPrompt: request.systemPrompt,
		extensionFactories: [
			...(options.sessionExtensions?.({ model, registry: () => ctx.modelRegistry, onUsage: request.onModelUsage }) ?? []),
			...(allowed.has("codemode") ? [createCodemodeExtension()] : []),
			...(allowed.has("tool_search") ? [createToolSearchExtension()] : []),
			...(request.toolNames.some((name) => name.startsWith("mcp__") || name.includes("mcp_resource")) ? [createMcpExtension()] : []),
			...(options.extensionFactories ?? []), guard,
		],
		extensionsOverride: (loaded) => ({ ...loaded, extensions: loaded.extensions.filter((extension) =>
			resolve(extension.resolvedPath) !== ownExtension && !extension.commands.has("agents") && !extension.commands.has("btw")) }),
	});
	await loader.reload({ resolveProjectTrust: async () => ctx.isProjectTrusted() });
	if (loader.getExtensions().errors.length) throw new Error(loader.getExtensions().errors.map((error) => `${error.path}: ${error.error}`).join("\n"));
	for (const extension of loader.getExtensions().extensions) for (const name of extension.flags.keys()) {
		const value = pi.getFlag(name);
		if (value !== undefined) loader.getExtensions().runtime.flagValues.set(name, value);
	}
	const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	const forward = () => runtime.registerProvider(model.provider, {
		api: model.api, apiKey: "pi2-parent-runtime", models: [{ ...model }],
		streamSimple: (_selected, context, streamOptions) => {
			request.onCheckpoint();
			const { apiKey: _key, ...rest } = streamOptions ?? {};
			const stream = ctx.modelRegistry.streamSimple(model, collapseSystemMessages(context), {
				...rest,
				...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
				...(request.streamOverride !== undefined ? { streamOverride: request.streamOverride } : {}),
			});
			void stream.result().then((message) => request.onModelUsage(message.usage), () => {});
			return stream;
		},
	});
	forward();
	signal.throwIfAborted();
	const { session } = await createAgentSession({
		cwd: ctx.cwd, agentDir: getAgentDir(), modelRuntime: runtime, model,
		thinkingLevel: request.thinkingLevel, settingsManager: settings, sessionManager: manager,
		// Add worker-owned tools only after filtering out the main extension. Inline
		// factories are conflict-checked before extensionsOverride runs.
		resourceLoader: loader, tools: [...allowed], customTools: request.communicationTools,
	});
	try {
		forward();
		await session.bindExtensions({ mode: "rpc", uiContext: request.ui });
		signal.throwIfAborted();
		const missing = request.toolNames.filter((name) => !name.startsWith("mcp__") && !session.getToolDefinition(name));
		if (missing.length) throw new Error(`Worker could not load parent tools: ${missing.join(", ")}. SDK hosts must supply worker extensionFactories; tools are never run without their extensions.`);
		return session;
	} catch (error) {
		try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
		finally { session.dispose(); }
		throw error;
	}
}
