// Explicit opt-in: payload logs can contain private prompts and tool results.
import { appendFileSync } from "node:fs";

export function rawDump(event: string, data: unknown): void {
	const path = process.env.PI2_RAW_DUMP;
	if (path) appendFileSync(path, `${JSON.stringify({ time: new Date().toISOString(), event, data })}\n`, { mode: 0o600 });
}
