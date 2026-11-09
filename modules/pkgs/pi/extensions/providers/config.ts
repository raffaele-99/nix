import { randomUUID } from "node:crypto";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai/compat";

// Request settings shared by stock and optional provider transports.
export interface ThreadConfig {
	threadId: string;
	effort: string | null;
	reasoningSummary: string | null;
	verbosity: string | null;
	serviceTier: string | null;
}

export type ServiceTier = "default" | "priority" | "ultrafast";

const fallbackSessionId = randomUUID();

export function requestConfig(options?: SimpleStreamOptions & { serviceTier?: string }, state?: { ultrafast?: boolean }): ThreadConfig {
	return {
		threadId: options?.sessionId ?? fallbackSessionId,
		effort: options?.reasoning ?? null,
		reasoningSummary: "auto",
		verbosity: null,
		// Per-request worker settings must not be overridden by the main thread.
		serviceTier: options?.serviceTier ?? (state?.ultrafast ? "ultrafast" : null),
	};
}
