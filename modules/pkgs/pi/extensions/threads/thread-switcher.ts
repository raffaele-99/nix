import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ThreadGroup = "side" | "worker";
interface ThreadTarget {
	list(ctx: ExtensionContext): string[];
	show(id: string, ctx: ExtensionContext, stillCurrent: () => boolean): Promise<void> | void;
	hide(): void;
	blocked(): boolean;
}

// Discover threads on each keypress, not just views that have already opened.
// Main -> existing side -> active workers in creation order -> main. Showing a saved
// thread must not start a turn. Only one group's overlay may be visible.
class ThreadSwitcher {
	private readonly targets = new Map<ThreadGroup, ThreadTarget>();
	private active?: { group: ThreadGroup; id: string };
	private pending?: Promise<void>;
	private generation = 0;
	private navigation = 0;

	constructor(pi: ExtensionAPI) {
		for (const key of ["ctrl+/", "ctrl+_", "ctrl+7"] as const) pi.registerShortcut(key, {
			description: "Cycle through main, side and active subagent threads",
			handler: (ctx) => this.cycle(ctx),
		});
		const reset = () => { this.generation++; this.main(); };
		pi.on("session_start", reset);
		pi.on("session_before_tree", reset);
		pi.on("session_shutdown", reset);
	}

	register(group: ThreadGroup, target: ThreadTarget): void { this.targets.set(group, target); }
	isActive(group: ThreadGroup): boolean { return this.active?.group === group; }
	activate(group: ThreadGroup, id: string): void {
		this.navigation++;
		this.active = { group, id };
		for (const [key, target] of this.targets) if (key !== group) target.hide();
	}
	release(group: ThreadGroup): void {
		if (this.isActive(group)) { this.navigation++; this.active = undefined; }
	}
	main(): void {
		this.navigation++;
		this.active = undefined;
		for (const target of this.targets.values()) target.hide();
	}

	private blocked(ctx: ExtensionContext): boolean {
		return ctx.mode !== "tui" || !ctx.hasUI || [...this.targets.values()].some((target) => target.blocked());
	}

	cycle(ctx: ExtensionContext): Promise<void> {
		if (this.blocked(ctx)) return Promise.resolve();
		const generation = this.generation;
		const run = async () => {
			if (generation !== this.generation || this.blocked(ctx)) return;
			try { await this.advance(ctx); }
			catch (error) { ctx.ui.notify(`Thread: ${error instanceof Error ? error.message : String(error)}`, "error"); }
		};
		// Opening a saved side session is asynchronous. Preserve keypress order
		// without letting queued presses cross a session/branch change.
		const pending = this.pending ? this.pending.then(run) : run();
		this.pending = pending;
		void pending.then(() => { if (this.pending === pending) this.pending = undefined; });
		return pending;
	}

	private async advance(ctx: ExtensionContext): Promise<void> {
		const threads = (["side", "worker"] as const).flatMap((group) =>
			(this.targets.get(group)?.list(ctx) ?? []).map((id) => ({ group, id })));
		const index = threads.findIndex((thread) => thread.group === this.active?.group && thread.id === this.active.id);
		// A worker can finish while being viewed, or be opened explicitly from
		// history. Leave that view on the next keypress without re-entering it.
		if (this.active && index < 0) { this.main(); return; }
		if (!threads.length) {
			this.main();
			ctx.ui.notify("No side or active subagent threads. Open a side thread with /btw.", "info");
			return;
		}
		const navigation = this.navigation;
		const stillCurrent = () => navigation === this.navigation && !this.blocked(ctx);
		for (const thread of threads.slice(index + 1)) {
			if (!stillCurrent()) return;
			try {
				await this.targets.get(thread.group)!.show(thread.id, ctx, stillCurrent);
				return;
			} catch (error) {
				if (!stillCurrent()) return;
				ctx.ui.notify(`Thread: ${error instanceof Error ? error.message : String(error)}`, "error");
				// A missing saved session must not trap navigation on that thread.
			}
		}
		this.main();
	}
}

const switchers = new WeakMap<ExtensionAPI, ThreadSwitcher>();
export function threadSwitcher(pi: ExtensionAPI): ThreadSwitcher {
	let switcher = switchers.get(pi);
	if (!switcher) { switcher = new ThreadSwitcher(pi); switchers.set(pi, switcher); }
	return switcher;
}
