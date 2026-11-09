import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Api, type AssistantMessage, type AssistantMessageEventStream, createAssistantMessageEventStream, getCurrentSystemMessage,
	type Model, type SimpleStreamOptions, type TranscriptContext, type Usage,
} from "@earendil-works/pi-ai/compat";
import {
	AgentSession, buildSessionProjection, calculateContextTokens, compact, estimateTokens,
	type CompactionEntry, type ContextUsage, type ExtensionAPI, type ModelRegistry, type ExtensionContext, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { registerHistoryProjector } from "../../threads/session-history.ts";

type WireItem = Record<string, any>;

const PREFIX = "pi2-openai-compaction-v1\n";
const COMPACTION_TYPES = new Set(["compaction", "compaction_summary", "context_compaction"]);
interface EncryptedContext { provider: string; model: string; items: WireItem[] }

export function supportsEncryptedCompaction(model: Model<Api> | undefined): model is Model<Api> {
	return model?.provider === "openai" && model.api === "openai-responses" ||
		model?.provider === "openai-codex" && model.api === "openai-codex-responses";
}

function isCheckpoint(item: unknown): item is WireItem {
	if (typeof item !== "object" || item === null) return false;
	const value = item as WireItem;
	return COMPACTION_TYPES.has(value.type) && typeof value.encrypted_content === "string" && value.encrypted_content.length > 0;
}

function checkpointInput(item: WireItem): WireItem {
	const { created_by: _createdBy, ...input } = item;
	return { ...input, type: "compaction" };
}

// A checkpoint replaces conversation history, not the executable context. Rebuild
// current system/tool state before each transport serializes it. The payload
// shaper then places input tool declarations AFTER the checkpoint: declarations
// before it are not part of the Responses API's effective tool catalog.
// Fold only through the checkpoint: later instruction/tool deltas must retain
// their position relative to surviving calls. Never rewrite saved session entries.
export function reconstructOpenAICompaction(context: TranscriptContext, model: Model<Api>): TranscriptContext {
	if (!supportsEncryptedCompaction(model)) return context;
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "assistant" || message.provider !== model.provider || message.api !== model.api || message.model !== model.id ||
			message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "pending") continue;
		for (let j = message.content.length - 1; j >= 0; j--) {
			const block = message.content[j];
			if (block.type !== "thinking" || !block.thinkingSignature) continue;
			let item: unknown;
			try { item = JSON.parse(block.thinkingSignature); } catch { continue; }
			if (!isCheckpoint(item)) continue;
			const system = getCurrentSystemMessage(context.messages.slice(0, i + 1));
			const checkpoint: AssistantMessage = { ...message, content: [
				{ ...block, thinkingSignature: JSON.stringify(checkpointInput(item)) }, ...message.content.slice(j + 1),
			] };
			return { ...context, messages: [...(system ? [system] : []), checkpoint, ...context.messages.slice(i + 1)] };
		}
	}
	return context;
}

export function shapeOpenAICompaction(body: WireItem, model: Model<Api>): WireItem {
	if (!supportsEncryptedCompaction(model)) return body;
	const shaped: WireItem = {
		...body,
		context_management: [{ type: "compaction", compact_threshold: Math.max(1000, Math.floor(model.contextWindow * 0.9)) }],
	};
	if (!Array.isArray(body.input)) return shaped;
	const checkpoint = body.input.findLastIndex(isCheckpoint);
	if (checkpoint < 0) return shaped;
	const prefix: WireItem[] = body.input.slice(0, checkpoint);
	const declarations = prefix.filter(item => item?.type === "additional_tools");
	if (declarations.length === 0) return shaped;
	// Reconstructed declarations must be registered again after the reset, before
	// any surviving calls. Keep later tool deltas in place and in order. Top-level
	// tools and saved transcripts are untouched.
	shaped.input = [
		...prefix.filter(item => item?.type !== "additional_tools"), body.input[checkpoint],
		...declarations, ...body.input.slice(checkpoint + 1),
	];
	return shaped;
}

// Install encrypted inline compaction on any Responses transport. 
export function streamWithEncryptedCompaction(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	stream: (model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const compaction = new OpenAICompaction();
	const input = stream(model, reconstructOpenAICompaction(context, model), {
		...options,
		onPayload: async (payload, payloadModel) =>
			shapeOpenAICompaction(((await options?.onPayload?.(payload, payloadModel)) ?? payload) as WireItem, model),
		onProviderStreamEvent: async (event, eventModel) => {
			compaction.observe(event as WireItem);
			await options?.onProviderStreamEvent?.(event, eventModel);
		},
	});
	const output = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of input) {
				if (event.type === "done") compaction.preserveHistory(event.message);
				output.push(event);
			}
		} catch (error) {
			const aborted = options?.signal?.aborted === true;
			output.push({ type: "error", reason: aborted ? "aborted" : "error", error: {
				role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [],
				usage: emptyUsage(), stopReason: aborted ? "aborted" : "error", timestamp: Date.now(),
				errorMessage: error instanceof Error ? error.message : String(error),
			} });
		} finally {
			output.end();
		}
	})();
	return output;
}

// Observe the real turn, not a separate compaction inference. Persist the latest
// completed checkpoint at its actual position relative to the visible output.
export class OpenAICompaction {
	private readonly indexes = new Map<string, number>();
	private checkpoint?: { index: number; item: WireItem };

	observe(event: WireItem): void {
		if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
			this.observeItem(event.item, event.output_index, event.type === "response.output_item.done");
		} else if (event.type === "response.completed" || event.type === "response.done") {
			if (Array.isArray(event.response?.output)) {
				event.response.output.forEach((item: WireItem, index: number) => this.observeItem(item, index, true));
			}
		}
	}

	private observeItem(item: WireItem, index: number, done: boolean): void {
		if (!item || !Number.isSafeInteger(index) || index < 0) return;
		for (const id of [item.id, item.call_id]) if (typeof id === "string") this.indexes.set(id, index);
		if (!done || !COMPACTION_TYPES.has(item.type)) return;
		if (!isCheckpoint(item)) throw new Error("OpenAI returned an invalid encrypted compaction item");
		const input = checkpointInput(item);
		if (!this.checkpoint || index > this.checkpoint.index) this.checkpoint = { index, item: input };
		else if (index === this.checkpoint.index && JSON.stringify(input) !== JSON.stringify(this.checkpoint.item)) {
			throw new Error("OpenAI returned conflicting encrypted compaction items");
		}
	}

	private blockIndex(block: AssistantMessage["content"][number]): number | undefined {
		if (block.type === "toolCall") {
			const [callId, itemId] = block.id.split("|");
			return this.indexes.get(itemId) ?? this.indexes.get(callId);
		}
		const signature = block.type === "thinking" ? block.thinkingSignature : block.type === "text" ? block.textSignature : undefined;
		if (!signature) return;
		try {
			return this.indexes.get(JSON.parse(signature).id);
		} catch {
			return this.indexes.get(signature);
		}
	}

	preserveHistory(message: AssistantMessage): void {
		if (!this.checkpoint || message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "pending") return;
		const { index, item } = this.checkpoint;
		// Also tolerate adapters which already expose compactions as thinking blocks.
		message.content = message.content.filter((block) => {
			if (block.type !== "thinking" || !block.thinkingSignature) return true;
			try { return !COMPACTION_TYPES.has(JSON.parse(block.thinkingSignature).type); }
			catch { return true; }
		});
		const position = message.content.findIndex((block) => (this.blockIndex(block) ?? Infinity) > index);
		message.content.splice(position < 0 ? message.content.length : position, 0,
			{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(item) });
	}
}

function encryptedContext(summary: string): EncryptedContext | undefined {
	if (!summary.startsWith(PREFIX)) return;
	return JSON.parse(summary.slice(PREFIX.length)) as EncryptedContext;
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function summarizedPrefix(branch: SessionEntry[], entry: CompactionEntry): AgentMessage[] {
	const before = branch.slice(0, branch.findIndex((candidate) => candidate.id === entry.id));
	const projected = buildSessionProjection(before).entries;
	const cut = entry.firstKeptEntryId === entry.id ? projected.length :
		projected.findIndex((candidate) => candidate.sourceEntry.id === entry.firstKeptEntryId);
	if (cut < 0) throw new Error("Cannot restore the history behind encrypted compaction");
	return projected.slice(0, cut).flatMap((candidate) => candidate.messages).filter((message) => message.role !== "system");
}

// Compatibility with checkpoints written by the previous standalone extension.
// New inline checkpoints live directly in the actual assistant turn's signatures.
export function projectEncryptedCompaction(messages: AgentMessage[], branch: SessionEntry[], model?: Model<Api>): AgentMessage[] {
	return messages.flatMap((message): AgentMessage[] => {
		if (message.role !== "compactionSummary") return [message];
		const saved = encryptedContext(message.summary);
		if (!saved) return [message];
		if (supportsEncryptedCompaction(model) && saved.provider === model.provider && saved.model === model.id) {
			const replay: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: saved.items.map((item) => ({ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(item) })),
				usage: emptyUsage(), stopReason: "stop", timestamp: message.timestamp,
			};
			return [replay];
		}
		const entry = branch.find((candidate): candidate is CompactionEntry => candidate.type === "compaction" && candidate.summary === message.summary);
		if (!entry) throw new Error("Encrypted compaction has no saved source history");
		return projectEncryptedCompaction(summarizedPrefix(branch, entry), branch, model);
	});
}

// Ciphertext length and the original transcript are not estimates of the model's
// current context. Only usage from a later response can measure the new context.
export function encryptedContextUsage(messages: AgentMessage[], model: Model<Api> | undefined): ContextUsage | undefined {
	if (!supportsEncryptedCompaction(model)) return;
	let checkpoint = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant" && message.provider === model.provider && message.model === model.id && message.api === model.api &&
			message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "pending") {
			if (message.content.some((block) => {
				if (block.type !== "thinking" || !block.thinkingSignature) return false;
				try { return isCheckpoint(JSON.parse(block.thinkingSignature)); } catch { return false; }
			})) { checkpoint = i; break; }
		} else if (message.role === "compactionSummary") {
			const saved = encryptedContext(message.summary);
			if (saved?.provider === model.provider && saved.model === model.id) { checkpoint = i; break; }
		}
	}
	if (checkpoint < 0) return;
	let trailing = 0;
	for (let i = messages.length - 1; i > checkpoint; i--) {
		const message = messages[i];
		// Usage from another model does not measure this model's encrypted context.
		if (message.role === "assistant" && message.provider === model.provider && message.model === model.id && message.api === model.api &&
			message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "pending" && calculateContextTokens(message.usage) > 0) {
			const tokens = calculateContextTokens(message.usage) + trailing;
			return { tokens, contextWindow: model.contextWindow, percent: tokens / model.contextWindow * 100 };
		}
		trailing += estimateTokens(message);
	}
	return { tokens: null, contextWindow: model.contextWindow, percent: null };
}

// Pi 1.2 has no extension API to disable native auto-compaction per session.
// Intercept BOTH decisions before compaction_start: _checkCompaction handles
// pre-prompt/recovery; _exceedsCompactionThreshold handles between-tool turns and
// virtual-model routing. Neither should run Pi's plaintext compactor when the
// provider owns compaction. Context accounting remains separate from cumulative
// session usage. The shim is session-scoped and reversible across reload/workers.
const ADAPTER = Symbol.for("pi2.openai-compaction-session-adapter-v2");
type CompactionCheck = (this: AgentSession, ...args: unknown[]) => Promise<boolean>;
type CompactionThreshold = (this: AgentSession, model: Model<Api>, ...args: unknown[]) => boolean;
interface SessionAdapter {
	sessions: Set<ExtensionContext["sessionManager"]>;
	check: CompactionCheck;
	threshold: CompactionThreshold;
	usage: AgentSession["getContextUsage"];
	originalCheck: CompactionCheck;
	originalThreshold: CompactionThreshold;
	originalUsage: AgentSession["getContextUsage"];
}
function attachCompactionSession(manager: ExtensionContext["sessionManager"]): () => void {
	const prototype = AgentSession.prototype as unknown as {
		_checkCompaction: CompactionCheck; _exceedsCompactionThreshold: CompactionThreshold;
		getContextUsage: AgentSession["getContextUsage"]; [ADAPTER]?: SessionAdapter;
	};
	let adapter = prototype[ADAPTER];
	if (!adapter) {
		const sessions = new Set<ExtensionContext["sessionManager"]>();
		const originalCheck = prototype._checkCompaction, originalThreshold = prototype._exceedsCompactionThreshold,
			originalUsage = prototype.getContextUsage;
		const check: CompactionCheck = function (...args) {
			if (sessions.has(this.sessionManager) && supportsEncryptedCompaction(this.routedModel?.model ?? this.model)) return Promise.resolve(false);
			return originalCheck.apply(this, args);
		};
		const threshold: CompactionThreshold = function (model, ...args) {
			if (sessions.has(this.sessionManager) && supportsEncryptedCompaction(model)) return false;
			return originalThreshold.call(this, model, ...args);
		};
		const usage: AgentSession["getContextUsage"] = function (this: AgentSession) {
			const model = this.routedModel?.model ?? this.model;
			if (sessions.has(this.sessionManager) && supportsEncryptedCompaction(model)) {
				const encrypted = encryptedContextUsage(this.sessionManager.buildSessionProjection().messages, model);
				if (encrypted) return encrypted;
			}
			return originalUsage.call(this);
		};
		adapter = { sessions, check, threshold, usage, originalCheck, originalThreshold, originalUsage };
		prototype[ADAPTER] = adapter;
		prototype._checkCompaction = check;
		prototype._exceedsCompactionThreshold = threshold;
		prototype.getContextUsage = usage;
	}
	const installed = adapter;
	installed.sessions.add(manager);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		installed.sessions.delete(manager);
		if (installed.sessions.size === 0) {
			if (prototype._checkCompaction === installed.check) prototype._checkCompaction = installed.originalCheck;
			if (prototype._exceedsCompactionThreshold === installed.threshold) prototype._exceedsCompactionThreshold = installed.originalThreshold;
			if (prototype.getContextUsage === installed.usage) prototype.getContextUsage = installed.originalUsage;
			delete prototype[ADAPTER];
		}
	};
}

interface CompactionOptions {
	registry?: (ctx: ExtensionContext) => ModelRegistry;
	onUsage?: (usage: Usage) => void;
}

export function registerOpenAICompaction(pi: ExtensionAPI, options: CompactionOptions = {}): void {
	let detach: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		detach?.();
		const detachSession = attachCompactionSession(ctx.sessionManager);
		const detachHistory = registerHistoryProjector(ctx.sessionManager, projectEncryptedCompaction);
		detach = () => { detachSession(); detachHistory(); };
	});
	pi.on("session_shutdown", () => { detach?.(); detach = undefined; });
	pi.on("context", (event, ctx) => ({ messages: projectEncryptedCompaction(event.messages, ctx.sessionManager.getBranch(), ctx.model) }));
	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!model) return;
		if (supportsEncryptedCompaction(model)) {
			// Let the real Responses turn compact itself. Never let Pi replace that
			// history with a plaintext summary or launch another model request.
			if (event.reason === "manual" && !event.signal.aborted) {
				ctx.ui.notify("OpenAI compacts automatically during normal turns; no separate compaction request was sent.", "info");
			}
			return { cancel: true };
		}
		const { preparation, branchEntries, signal } = event;
		try {
			if (!preparation.previousSummary || !encryptedContext(preparation.previousSummary)) return;
			signal.throwIfAborted();
			// A model switch must not summarize ciphertext or lose the old context.
			const restored = projectEncryptedCompaction([{
				role: "compactionSummary", summary: preparation.previousSummary, tokensBefore: preparation.tokensBefore, timestamp: 0,
			}], branchEntries);
			const registry = options.registry?.(ctx) ?? ctx.modelRegistry;
			const result = await compact({ ...preparation, previousSummary: undefined,
				messagesToSummarize: [...restored, ...preparation.messagesToSummarize] }, model,
				undefined, undefined, event.customInstructions, signal, ctx.thinkingLevel,
				(selected, context, streamOptions) => registry.stream(selected, context, streamOptions),
				undefined, undefined, undefined, ctx.sessionManager.getSessionId());
			signal.throwIfAborted();
			options.onUsage?.(result.usage ?? emptyUsage());
			return { compaction: result };
		} catch (error) {
			if (!signal.aborted) ctx.ui.notify(`Compaction failed; history unchanged: ${error instanceof Error ? error.message : String(error)}`, "error");
			return { cancel: true };
		}
	});
}
