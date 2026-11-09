import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CachedUsageWindow, ConnectedProvider, ProviderUsage, ProviderUsageCache, UsageSnapshot } from "./state.ts";
import { formatFooterUsageDelta, formatUsage, roundPercent } from "../usage/usage-format.ts";

export { formatFooterUsageDelta, formatUsage, formatUsageDelta } from "../usage/usage-format.ts";

const SNAPSHOT_INTERVAL_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const WEEK_SECONDS = 7 * 24 * 3600;

export function weeklyWindow(usage: ProviderUsage): CachedUsageWindow | undefined {
	return [usage.primary, usage.secondary].find((window) => window?.limitWindowSeconds === WEEK_SECONDS);
}

export function snapshotPath(id: string): string {
	return join(getAgentDir(), `${id}-usage-snapshots.json`);
}

function isSnapshot(value: unknown): value is UsageSnapshot {
	return typeof value === "object" && value !== null &&
		"dateTime" in value && typeof value.dateTime === "string" && Number.isFinite(Date.parse(value.dateTime)) &&
		"usage" in value && typeof value.usage === "number" && Number.isFinite(value.usage);
}

async function readSnapshots(path: string): Promise<UsageSnapshot[]> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return Array.isArray(value)
			? value.filter(isSnapshot).sort((a, b) => Date.parse(a.dateTime) - Date.parse(b.dateTime))
			: [];
	} catch {
		return [];
	}
}

async function writeSnapshots(path: string, snapshots: readonly UsageSnapshot[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(snapshots)}\n`, { mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}

export interface UsageMonitor {
	refresh(ctx: ExtensionContext): Promise<void>;
	dispose(): void;
}

export function createUsageMonitor(
	entry: ConnectedProvider,
	changed: () => void,
	cached: () => void,
	path = entry.connector.snapshotPath?.() ?? snapshotPath(entry.connector.id),
): UsageMonitor {
	const { connector, state } = entry;
	let refreshing: Promise<void> | undefined;
	let resetTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const clearResetTimer = (): void => {
		clearTimeout(resetTimer);
		resetTimer = undefined;
	};

	const updateSnapshots = async (usage: ProviderUsageCache): Promise<string | undefined> => {
		clearResetTimer();
		const weekly = weeklyWindow(usage);
		if (!weekly) {
			state.recentChange = undefined;
			return undefined;
		}
		const now = Date.parse(usage.observedAt);
		const resetMs = weekly.resetAt * 1000;
		if (resetMs > now) {
			resetTimer = setTimeout(() => {
				resetTimer = undefined;
				state.usageDeltaText = undefined;
				state.snapshots = [];
				state.recentChange = undefined;
				void writeSnapshots(path, []).catch(() => {});
				changed();
			}, resetMs - now + 1000);
			resetTimer.unref();
		}
		try {
			const windowStart = resetMs - weekly.limitWindowSeconds * 1000;
			let snapshots = (await readSnapshots(path)).filter((snapshot) => {
				const time = Date.parse(snapshot.dateTime);
				return time >= windowStart && time <= now;
			});
			if (disposed) return undefined;
			const latest = snapshots.at(-1);
			const delta = formatFooterUsageDelta(snapshots, weekly.usedPercent, now);
			state.recentChange = latest ? {
				percentagePointsUsed: roundPercent(weekly.usedPercent - latest.usage),
				since: latest.dateTime,
				observedAt: usage.observedAt,
				elapsedSeconds: Math.max(0, Math.round((now - Date.parse(latest.dateTime)) / 1000)),
			} : undefined;
			if (!latest || now - Date.parse(latest.dateTime) >= SNAPSHOT_INTERVAL_MS) {
				snapshots.push({ dateTime: usage.observedAt, usage: weekly.usedPercent });
			}
			const cutoff = Date.parse(snapshots.at(-1)!.dateTime) - DAY_MS;
			snapshots = snapshots.filter((snapshot) => Date.parse(snapshot.dateTime) >= cutoff);
			state.snapshots = snapshots;
			await writeSnapshots(path, snapshots);
			return delta;
		} catch {
			if (!disposed) state.recentChange = undefined;
			return undefined;
		}
	};

	const refreshUsage = async (ctx: ExtensionContext): Promise<void> => {
		try {
			const usage = await connector.readUsage!(ctx);
			if (disposed) return;
			const cache: ProviderUsageCache = { ...usage, observedAt: new Date().toISOString() };
			state.usageCache = cache;
			state.usageText = formatUsage(state.label, cache, Date.parse(cache.observedAt));
			const delta = await updateSnapshots(cache);
			if (disposed) return;
			state.usageDeltaText = delta;
			cached();
		} catch {
			if (disposed) return;
			state.usageText = `${state.label} usage unavailable`;
			state.usageDeltaText = undefined;
		} finally {
			if (!disposed) changed();
		}
	};

	return {
		refresh(ctx: ExtensionContext): Promise<void> {
			if (disposed) return Promise.resolve();
			refreshing ??= refreshUsage(ctx).finally(() => { refreshing = undefined; });
			return refreshing;
		},
		dispose(): void {
			disposed = true;
			clearResetTimer();
		},
	};
}
