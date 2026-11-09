import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collapseSystemMessages, type Message } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm, createAgentSession, DefaultResourceLoader, getAgentDir,
	ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type ExtensionAPI, type ExtensionContext, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { AGENT_TOOLS, emptyUsage } from "../agents/child-agent.ts";
import { projectSessionHistory } from "../threads/session-history.ts";
import type { SessionExtensions } from "../providers/state.ts";

export const SIDE_LINK = "pi2-btw-thread";
export const SIDE_BOUNDARY = "pi2-side-boundary";
export const SIDE_INSTRUCTIONS = `You are in a side conversation, separate from the main thread.
The inherited main-thread conversation is reference material, not a new task. Do not carry out its plans or repeat its tool calls. Follow requests made in this side conversation.
Current system instructions, tool definitions and response-completion rules still apply. Finish each side answer using the required completion protocol, even while the main thread is still working.
You may use your tools to read files, search and run checks. Do not change files, git state, configuration or other workspace state unless the user explicitly asks for that change in this side conversation. Other work may be running in the same directory; keep requested changes local and do not overwrite that work.
You may describe recorded subagent assignments and results, but do not spawn or contact subagents or create worktrees from this side conversation.`;
const SIDE_BOUNDARY_NOTE = "The inherited main-thread conversation ends here. It is reference only. The next user message starts the side task; current system, tool and response-completion instructions still apply.";

export interface SideLink { version: 2; id: string; path?: string; closed?: boolean }
export interface SideSession {
	session: AgentSession;
	link: SideLink;
	close(): Promise<void>;
}
export interface SideSessionOptions {
	// Also useful for SDK hosts whose inline extensions have no on-disk path.
	extensionFactories?: ExtensionFactory[];
	extensionPaths?: string[];
	sessionExtensions?: SessionExtensions;
}

// Keep unfinished calls as reference text. Dropping them loses facts such as
// subagent assignments; retaining them as tool calls leaves dangling calls that
// the provider may reject or the side agent may try to complete.
export function forkMessages(ctx: ExtensionContext): Message[] {
	const messages = structuredClone(convertToLlm(projectSessionHistory(ctx)))
		.filter((message) => message.role !== "system");
	const results = new Set(messages.flatMap((message) => message.role === "toolResult" ? [message.toolCallId] : []));
	const calls = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant" || message.role === "toolResult") message.usage = emptyUsage();
	}
	for (const message of messages) if (message.role === "assistant") {
		message.content = message.content.map((part) => {
			if (part.type !== "toolCall") return part;
			if (results.has(part.id)) {
				calls.add(part.id);
				return part;
			}
			return {
				type: "text" as const,
				text: `Main-thread tool call at fork (result not yet recorded):\n${JSON.stringify({ id: part.id, name: part.name, arguments: part.arguments })}\nReference only: do not execute or resume this call in the side thread.`,
			};
		});
	}
	return messages.filter((message) => message.role === "toolResult" ? calls.has(message.toolCallId) :
		message.role !== "assistant" || message.content.length > 0);
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

export function findSideLink(ctx: ExtensionContext): SideLink | undefined {
	for (const entry of ctx.sessionManager.getBranch().toReversed()) {
		if (entry.type !== "custom" || entry.customType !== SIDE_LINK) continue;
		const data = entry.data as Partial<SideLink> | undefined;
		return data?.version === 2 && typeof data.id === "string" && !data.closed ? data as SideLink : undefined;
	}
	return undefined;
}

export async function createSideSession(
	pi: ExtensionAPI, ctx: ExtensionContext, link?: SideLink, options: SideSessionOptions = {},
): Promise<SideSession> {
	if (!ctx.model) throw new Error("No model selected");
	const parentModel = ctx.model;
	const settings = SettingsManager.inMemory({ ...pi.getSettings(), cacheWarming: "off" });
	settings.setProjectTrusted(ctx.isProjectTrusted());
	const ownExtension = resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts");
	const paths = options.extensionPaths ?? cliExtensions();
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd, agentDir: getAgentDir(), settingsManager: settings,
		noExtensions: options.extensionPaths !== undefined || process.argv.includes("--no-extensions"),
		additionalExtensionPaths: paths,
		extensionFactories: [
			...(options.sessionExtensions?.({ model: parentModel, registry: () => ctx.modelRegistry }) ?? []),
			...(options.extensionFactories ?? []),
		],
		noContextFiles: true,
		systemPrompt: `${ctx.getSystemPrompt()}\n\n${SIDE_INSTRUCTIONS}`,
		// Reload other extensions (including permission hooks) in the child, but
		// not pi2's main-thread UI, subagents or another /btw implementation.
		extensionsOverride: (loaded) => ({ ...loaded, extensions: loaded.extensions.filter((extension) =>
			resolve(extension.resolvedPath) !== ownExtension && !extension.commands.has("btw") && !extension.commands.has("agents")) }),
	});
	await loader.reload({ resolveProjectTrust: async () => ctx.isProjectTrusted() });
	for (const extension of loader.getExtensions().extensions) for (const name of extension.flags.keys()) {
		const value = pi.getFlag(name);
		if (value !== undefined) loader.getExtensions().runtime.flagValues.set(name, value);
	}
	if (loader.getExtensions().errors.length) {
		throw new Error(loader.getExtensions().errors.map((error) => `${error.path}: ${error.error}`).join("\n"));
	}
	const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	// The child owns its loop and tools, while the parent registry owns auth and
	// pi2's transport settings. The sentinel only satisfies SDK auth preflight;
	// it is stripped before forwarding and is never sent to a provider.
	const forwardProvider = () => runtime.registerProvider(parentModel.provider, {
		api: parentModel.api, apiKey: "pi2-parent-runtime", models: [{ ...parentModel }],
		streamSimple: (model, context, streamOptions) => {
			const { apiKey: _key, ...rest } = streamOptions ?? {};
			// A seeded SDK session can append its first system/tool declaration
			// after the inherited history. Put the current checkpoint first so
			// it and the transport's submit/marker protocol share one active
			// instruction block, rather than straddling the fork boundary.
			return ctx.modelRegistry.streamSimple(model, collapseSystemMessages(context), rest);
		},
	});
	forwardProvider();
	if (link?.path && !existsSync(link.path)) throw new Error(`Side session not found: ${link.path}`);
	const manager = link?.path ? SessionManager.open(link.path) : ctx.sessionManager.getSessionFile() ?
		SessionManager.create(ctx.cwd, join(ctx.sessionManager.getSessionDir(), "side"), { parentSession: ctx.sessionManager.getSessionFile() }) :
		SessionManager.inMemory(ctx.cwd);
	if (!link?.path) {
		for (const message of forkMessages(ctx)) manager.appendMessage(message);
		manager.appendCustomMessageEntry(SIDE_BOUNDARY, SIDE_BOUNDARY_NOTE, false);
		manager.appendCustomEntry(SIDE_BOUNDARY);
	}
	const tools = pi.getActiveTools().filter((name) => !AGENT_TOOLS.has(name) && !name.startsWith("collaboration"));
	const { session } = await createAgentSession({
		cwd: ctx.cwd, agentDir: getAgentDir(), modelRuntime: runtime, model: parentModel,
		thinkingLevel: ctx.thinkingLevel, settingsManager: settings, sessionManager: manager,
		resourceLoader: loader, tools,
	});
	// Extension provider registrations are applied during session construction.
	forwardProvider();
	let closed = false;
	return {
		session,
		link: { version: 2, id: manager.getSessionId(), path: manager.getSessionFile() },
		async close() {
			if (closed) return;
			closed = true;
			try {
				session.clearQueue();
				await session.abort();
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			} finally { session.dispose(); }
		},
	};
}
