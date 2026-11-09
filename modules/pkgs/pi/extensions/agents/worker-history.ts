import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ServiceTier } from "../providers/config.ts";
import { parseSessionEntries, SessionManager, type ExtensionContext, type FileEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const WORKER_HISTORY = "pi2-worker-history";
export interface WorkerResult {
	id: string;
	name: string;
	task: string;
	status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "closed";
	output: string;
	progress?: string;
	error?: string;
	turns: number;
	compactions: number;
	usage: Usage;
}
export interface WorkerHistory {
	version: 1;
	assignment: string;
	worker: WorkerResult;
	mailbox?: string[];
	unreportedUsage?: Usage;
	settings?: { provider: string; model: string; thinkingLevel: ThinkingLevel; serviceTier?: ServiceTier; streamOverride?: boolean };
	session?: { path?: string; leafId: string | null; entries?: FileEntry[] };
}

export function readWorkerHistory(ctx: ExtensionContext): WorkerHistory[] {
	const records = new Map<string, WorkerHistory>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== WORKER_HISTORY) continue;
		const data = entry.data as WorkerHistory | undefined;
		if (data?.version === 1 && typeof data.worker?.id === "string") records.set(data.worker.id, data);
	}
	return [...records.values()];
}

export function findWorkerHistory(ctx: ExtensionContext, id: string): WorkerHistory {
	const records = readWorkerHistory(ctx).filter((record) => record.worker.id === id || record.worker.id.startsWith(id));
	if (!id || !records.length) throw new Error(`Unknown worker ${id}; use /agents to list resumable workers in this branch`);
	if (records.length !== 1) throw new Error(`Ambiguous worker ID ${id}; use a longer ID from /agents`);
	return records[0];
}

export function captureWorkerSession(manager: SessionManager): WorkerHistory["session"] {
	const path = manager.getSessionFile();
	return { path, leafId: manager.getLeafId(),
		...(!path ? { entries: structuredClone([manager.getHeader()!, ...manager.getEntries()]) } : {}) };
}

// Read exactly this parent branch's checkpoint without forking, repairing tool
// calls, loading extensions, or writing anything to the saved worker session.
export function readWorkerBranch(ctx: ExtensionContext, saved: WorkerHistory["session"]): SessionEntry[] {
	if (!saved?.leafId) return [];
	if (saved.path && !existsSync(saved.path)) throw new Error(`Worker session not found: ${saved.path}`);
	const entries = saved.path ? parseSessionEntries(readFileSync(saved.path, "utf8")) : structuredClone(saved.entries);
	const manager = SessionManager.inMemory(ctx.cwd, undefined, entries);
	if (!manager.getEntry(saved.leafId)) throw new Error(`Worker checkpoint not found: ${saved.leafId}`);
	return manager.getBranch(saved.leafId);
}

export function openWorkerSession(ctx: ExtensionContext, history?: WorkerHistory): SessionManager {
	const saved = history?.session;
	let manager: SessionManager;
	// No committed entries means no model/tool work began; restart that empty session.
	if (!saved?.leafId) {
		const parentSession = ctx.sessionManager.getSessionFile();
		manager = parentSession ? SessionManager.create(ctx.cwd, join(ctx.sessionManager.getSessionDir(), "workers"), { parentSession }) :
			SessionManager.inMemory(ctx.cwd);
	} else {
		if (saved.path && !existsSync(saved.path)) throw new Error(`Worker session not found: ${saved.path}`);
		manager = saved.path ? SessionManager.open(saved.path) : SessionManager.inMemory(ctx.cwd, undefined, structuredClone(saved.entries));
		// Resume exactly the checkpoint owned by this parent branch. A new physical
		// session prevents forks/concurrent parents from mutating one another's worker.
		manager.createBranchedSession(saved.leafId);
		repairInterruptedTools(manager);
	}
	return manager;
}

function repairInterruptedTools(manager: SessionManager): void {
	const pending = new Map<string, string>();
	for (const message of manager.buildSessionContext().messages) {
		if (message.role === "assistant") for (const part of message.content) {
			if (part.type === "toolCall") pending.set(part.id, part.name);
		}
		if (message.role === "toolResult") pending.delete(message.toolCallId);
	}
	for (const [toolCallId, toolName] of pending) manager.appendMessage({
		role: "toolResult", toolCallId, toolName, isError: true, timestamp: Date.now(),
		content: [{ type: "text", text: "Worker interrupted before this tool's result was saved. Its outcome is unknown; inspect the current state before retrying, especially for writes or commands with side effects. This call has not been replayed." }],
	});
}
