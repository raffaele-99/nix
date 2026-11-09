import type { ProviderUsage, UsageSnapshot } from "../providers/state.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const compactNumbers = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function roundPercent(value: number): number {
	return Math.round(value * 10) / 10;
}

export function formatUsageDelta(baseline: UsageSnapshot | undefined, currentUsage: number, now: number): string | undefined {
	if (!baseline) return undefined;
	const elapsed = now - Date.parse(baseline.dateTime);
	const delta = roundPercent(currentUsage - baseline.usage);
	if (!Number.isFinite(elapsed) || elapsed < 0 || !Number.isFinite(delta)) return undefined;
	const minutes = Math.max(1, Math.round(elapsed / MINUTE_MS));
	const window = minutes < 60 ? `${minutes}min` : `~${Math.round(minutes / 60)}h`;
	return `${delta}% used in last ${window}`;
}

export function formatFooterUsageDelta(snapshots: readonly UsageSnapshot[], currentUsage: number, now: number): string | undefined {
	let fastest: { baseline: UsageSnapshot; rate: number } | undefined;
	for (const baseline of snapshots) {
		const elapsed = now - Date.parse(baseline.dateTime);
		if (!Number.isFinite(elapsed) || elapsed < MINUTE_MS || elapsed > DAY_MS) continue;
		const change = roundPercent(currentUsage - baseline.usage);
		if (!Number.isFinite(change) || change <= 0) continue;
		const rate = change / (elapsed / HOUR_MS);
		if (!fastest || rate > fastest.rate) fastest = { baseline, rate };
	}
	return fastest ? formatUsageDelta(fastest.baseline, currentUsage, now) : undefined;
}

function windowName(seconds: number): string {
	const minutes = Math.round(seconds / 60);
	if (minutes % 1440 === 0) return `${minutes / 1440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function resetCountdown(resetAt: number, now: number): string {
	const minutes = Math.max(0, Math.ceil((resetAt * 1000 - now) / MINUTE_MS));
	if (minutes === 0) return "now";
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	return `${minutes}m`;
}

function compactNumber(value: string): string {
	const number = Number(value);
	return Number.isFinite(number) ? compactNumbers.format(number) : value;
}

export function formatUsage(label: string, usage: ProviderUsage, now = Date.now()): string {
	const parts = [label];
	for (const window of [usage.primary, usage.secondary]) {
		if (window) parts.push(`${windowName(window.limitWindowSeconds)} ${Math.round(100 - window.usedPercent)}% left`);
	}
	if (usage.primary) parts.push(`reset ${resetCountdown(usage.primary.resetAt, now)}`);
	if (usage.credits?.unlimited) parts.push("unlimited credits");
	else if (usage.credits?.balance !== undefined) parts.push(`${compactNumber(usage.credits.balance)} credits`);
	return parts.join(" · ");
}
