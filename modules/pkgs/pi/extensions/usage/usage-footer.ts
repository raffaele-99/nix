import {
	FooterComponent,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { activeProvider, type ConnectedProvider } from "../providers/state.ts";
import { createUsageMonitor } from "../providers/usage.ts";

const REFRESH_INTERVAL_MS = 5 * 60_000;

function colorAccount(text: string, theme: Theme): string {
	return text.split(" · ").map((part, index) => {
		const color = index === 0 ? "muted"
			: part.startsWith("reset ") ? "warning"
			: part.endsWith(" left") ? "success"
			: part.includes("% used in last ") ? "error"
			: part.endsWith("credits") ? "borderAccent"
			: "muted";
		return `${index > 0 ? theme.fg("dim", " · ") : ""}${theme.fg(color, part)}`;
	}).join("");
}

function placeStatus(stats: string, suffix: string, autoLabel: string, hideCost: boolean, theme: Theme): string {
	const clean = (hideCost ? stats.replace(/\$\d+(?:\.\d+)?(?:\s+\(sub\))?\s*/g, "") : stats).replace("(auto)", autoLabel);
	if (!suffix) return clean;
	const auto = clean.indexOf(autoLabel);
	const insertion = auto >= 0 ? auto + autoLabel.length : clean.length;
	return clean.slice(0, insertion) + theme.fg("accent", suffix) + clean.slice(insertion);
}

function footerSession(context: () => ExtensionContext): AgentSession {
	// FooterComponent requires AgentSession; adapt only the fields it reads.
	return {
		get state() {
			return { model: context().model, thinkingLevel: context().thinkingLevel };
		},
		get model() { return context().model; },
		get sessionManager() { return context().sessionManager; },
		getContextUsage: () => context().getContextUsage(),
		modelRuntime: { isUsingSubscription: () => false },
	} as unknown as AgentSession;
}

export interface ProviderFooterOptions {
	/** Independent features may add status rows without coupling the renderer to them. */
	statusKeys?: readonly string[];
}

export default function providerFooter(
	pi: ExtensionAPI,
	connected: readonly ConnectedProvider[],
	onUsageCached: (entry: ConnectedProvider) => void,
	options: ProviderFooterOptions = {},
): void {
	let currentContext: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let disposeFooter: (() => void) | undefined;
	let stopped = false;
	const monitors = connected.filter((entry) => entry.connector.readUsage).map((entry) => createUsageMonitor(
		entry,
		() => tui?.requestRender(),
		() => onUsageCached(entry),
	));

	const refresh = (ctx: ExtensionContext): void => {
		if (stopped || ctx.mode !== "tui") return;
		currentContext = ctx;
		for (const monitor of monitors) void monitor.refresh(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		if (stopped || ctx.mode !== "tui") return;
		currentContext = ctx;
		timer ??= setInterval(() => {
			if (currentContext) refresh(currentContext);
		}, REFRESH_INTERVAL_MS);
		timer.unref();
		ctx.ui.setFooter((footerTui, theme, footerData) => {
			disposeFooter?.();
			tui = footerTui;
			const builtIn = new FooterComponent(footerSession(() => currentContext ?? ctx), footerData);
			const unsubscribe = footerData.onBranchChange(() => footerTui.requestRender());
			const dispose = (): void => {
				if (disposeFooter !== dispose) return;
				disposeFooter = undefined;
				unsubscribe();
				builtIn.dispose();
				tui = undefined;
			};
			disposeFooter = dispose;
			return {
				render(width: number): string[] {
					if (!currentContext) return [];
					const home = process.env.HOME || process.env.USERPROFILE;
					const cwd = currentContext.sessionManager.getCwd();
					let directory = cwd === home ? "~" : home && cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
					const branch = footerData.getGitBranch();
					if (branch) directory += ` (${branch})`;
					directory = truncateToWidth(directory, Math.max(8, Math.floor(width * 0.3)), "...");
					const directoryPrefix = theme.fg("dim", `${directory} · `);
					const model = currentContext.model;
					const active = activeProvider(connected, model?.provider);
					const suffix = active && model
						? (active.status?.(model) ?? active.connector.status?.(model) ?? []).map((status) => ` · ${status}`).join("") : "";
					const autoLabel = active && model ? active.connector.autoCompactionLabel?.(model) ?? "(auto)" : "(auto)";
					const insertedWidth = visibleWidth(suffix) + visibleWidth(autoLabel) - visibleWidth("(auto)");
					const reserved = visibleWidth(directoryPrefix) + insertedWidth;
					const hasUsage = !!active?.connector.readUsage;
					const usageText = hasUsage ? [active!.state.usageText, active!.state.usageDeltaText].filter(Boolean).join(" · ") : "";
					const account = truncateToWidth(usageText, Math.max(0, width - reserved - 24), "...");
					const prefix = hasUsage
						? directoryPrefix + colorAccount(account, theme) + theme.fg("dim", " · ")
						: directoryPrefix;
					const remaining = width - visibleWidth(prefix) - insertedWidth;
					const compact = remaining < 20;
					const statsWidth = compact ? Math.max(1, width - reserved) : remaining;
					const stats = builtIn.render(statsWidth)[1] ?? "";
					const hideCost = !!(model && active?.connector.hideCost?.(model));
					const line = (compact ? directoryPrefix : prefix) + placeStatus(stats, suffix, autoLabel, hideCost, theme);
					const statuses = footerData.getExtensionStatuses();
					const extra = (options.statusKeys ?? []).flatMap((key) => {
						const status = statuses.get(key);
						if (!status) return [];
						const text = truncateToWidth(status, width, "...");
						return [theme.fg("dim", " ".repeat(Math.max(0, width - visibleWidth(text))) + text)];
					});
					return [truncateToWidth(line, width, "..."), ...extra];
				},
				invalidate: () => builtIn.invalidate(),
				dispose,
			};
		});
		refresh(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		if (stopped || ctx.mode !== "tui") return;
		currentContext = ctx;
		tui?.requestRender();
	});
	pi.on("agent_end", (_event, ctx) => {
		refresh(ctx);
	});
	pi.on("session_shutdown", () => {
		stopped = true;
		clearInterval(timer);
		timer = undefined;
		for (const monitor of monitors) monitor.dispose();
		disposeFooter?.();
		currentContext = undefined;
		tui = undefined;
	});
}
