import type { ExtensionAPI, ExtensionContext, ExtensionUIDialogOptions, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type OverlayHandle } from "@earendil-works/pi-tui";
import { createSideSession, findSideLink, SIDE_LINK, type SideSession, type SideSessionOptions } from "./side-session.ts";
import { SideView } from "./side-view.ts";
import { threadSwitcher } from "../threads/thread-switcher.ts";

export function registerBtw(pi: ExtensionAPI, options: SideSessionOptions = {}): void {
	let side: SideSession | undefined;
	let opening: Promise<SideSession> | undefined;
	let generation = 0;
	let lifetime = new AbortController();
	let overlay: OverlayHandle | undefined;
	let view: SideView | undefined;
	let render = () => {};
	let visible = false;
	let dialogs = 0;
	let unsubscribe = () => {};
	let viewContext: ExtensionContext | undefined;
	const switcher = threadSwitcher(pi);

	const refresh = (ctx: ExtensionContext) => {
		const toggle = switcher.isActive("side") ? " · Ctrl+/ next" : "";
		ctx.ui.setStatus("pi2-btw", side ? `Side ${side.session.isStreaming ? "working" : "ready"}${toggle}` : undefined);
		render();
	};
	const setVisible = (value: boolean, ctx: ExtensionContext) => {
		visible = value;
		if (value) switcher.activate("side", "side");
		overlay?.setHidden(!value || dialogs > 0);
		if (value && dialogs === 0) overlay?.focus();
		refresh(ctx);
	};
	const report = (ctx: ExtensionContext, error: unknown) => ctx.ui.notify(`Side thread: ${error instanceof Error ? error.message : String(error)}`, "error");
	const abort = async () => {
		side?.session.clearQueue();
		await side?.session.abort();
	};

	const stop = async (ctx: ExtensionContext) => {
		generation++;
		lifetime.abort();
		visible = false;
		switcher.release("side");
		ctx.ui.setWidget("pi2-btw-view", undefined);
		unsubscribe();
		unsubscribe = () => {};
		const current = side;
		side = undefined;
		await opening?.catch(() => {});
		await current?.close();
		refresh(ctx);
	};

	// Side extensions get their own session/tool context. Dialogs are forwarded
	// to the terminal, but their editor/footer changes must not touch the main UI.
	const childUI = (ctx: ExtensionContext, child: SideSession): ExtensionUIContext => {
		const withSignal = (opts?: ExtensionUIDialogOptions): ExtensionUIDialogOptions => ({
			...opts,
			signal: AbortSignal.any([lifetime.signal, ...[opts?.signal, child.session.agent.signal].filter((signal): signal is AbortSignal => !!signal)]),
		});
		const dialog = async <T>(run: () => Promise<T>): Promise<T> => {
			dialogs++;
			overlay?.setHidden(true);
			try { return await run(); }
			finally { dialogs--; setVisible(visible, ctx); }
		};
		return {
			...ctx.ui,
			select: (title, items, opts) => dialog(() => ctx.ui.select(`[Side] ${title}`, items, withSignal(opts))),
			confirm: (title, message, opts) => dialog(() => ctx.ui.confirm(`[Side] ${title}`, message, withSignal(opts))),
			input: (title, placeholder, opts) => dialog(() => ctx.ui.input(`[Side] ${title}`, placeholder, withSignal(opts))),
			editor: (title, prefill) => dialog(() => ctx.ui.editor(`[Side] ${title}`, prefill)),
			custom: (factory, opts) => dialog(() => ctx.ui.custom(factory, opts)),
			notify: (message, type) => ctx.ui.notify(`[Side] ${message}`, type),
			setStatus: () => {}, setWidget: () => {}, setFooter: () => {}, setHeader: () => {}, setTitle: () => {},
			setEditorComponent: () => {}, getEditorComponent: () => undefined,
			setEditorText: (text) => view?.setDraft(text), getEditorText: () => view?.getDraft() ?? "",
			pasteToEditor: (text) => view?.setDraft((view.getDraft() ?? "") + text),
			onTerminalInput: () => () => {}, addAutocompleteProvider: () => {},
			setWorkingMessage: () => {}, setWorkingVisible: () => {}, setWorkingIndicator: () => {}, setHiddenThinkingLabel: () => {},
		};
	};

	const ensure = (ctx: ExtensionContext): Promise<SideSession> => {
		if (side) return Promise.resolve(side);
		if (opening) return opening;
		const token = generation;
		lifetime = new AbortController();
		opening = (async () => {
			const child = await createSideSession(pi, ctx, findSideLink(ctx), options);
			try {
				await child.session.bindExtensions({
					mode: "rpc", uiContext: childUI(ctx, child), onError: (error) => report(ctx, error.error),
					abortHandler: () => { child.session.clearQueue(); void child.session.abort(); },
				});
				if (token !== generation) throw new Error("Closed while opening");
				side = child;
				pi.appendEntry(SIDE_LINK, child.link);
				unsubscribe = child.session.subscribe((event) => {
					if (event.type === "agent_start" || event.type === "agent_settled") refresh(ctx);
					if (event.type === "agent_settled" && ctx.mode === "rpc") ctx.ui.notify(`[Side] ${child.session.getLastAssistantText() ?? "Turn finished."}`, "info");
				});
				refresh(ctx);
				return child;
			} catch (error) { await child.close(); throw error; }
		})().finally(() => { opening = undefined; });
		return opening;
	};

	const submit = (text: string, ctx: ExtensionContext) => {
		const child = side;
		if (!child) return;
		if (text === "/main") { switcher.main(); return; }
		if (text === "/btw" || text.startsWith("/btw ")) { void command(text.slice(4).trim(), ctx).catch((error) => report(ctx, error)); return; }
		const token = generation;
		void child.session.prompt(text, { streamingBehavior: "steer" }).catch((error) => { if (token === generation) report(ctx, error); });
	};

	const show = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || !side) return;
		viewContext = ctx;
		if (overlay) { setVisible(true, ctx); return; }
		switcher.activate("side", "side");
		visible = true;
		// Own a non-blocking overlay through a zero-height widget. ui.custom()
		// would mark the parent as waiting for input for this view's entire life,
		// hiding subsequent permission-dialog events from the main thread.
		ctx.ui.setWidget("pi2-btw-view", (tui, theme) => {
			render = () => tui.requestRender();
			view = new SideView(tui, theme, getKeybindings(), side!.session, {
				submit: (text) => submit(text, ctx), next: () => { void switcher.cycle(ctx); }, main: () => switcher.main(),
				close: () => { void command("close", ctx).catch((error) => report(ctx, error)); },
				abort: () => { void abort().catch((error) => report(ctx, error)); },
				mainStatus: () => dialogs ? "needs input" : ctx.isIdle() ? "idle" : "working",
			});
			overlay = tui.showOverlay(view, { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 });
			setVisible(true, ctx);
			return {
				render: () => [],
				invalidate: () => view?.invalidate(),
				dispose: () => {
					overlay?.hide(); view?.dispose();
					overlay = undefined; view = undefined; render = () => {};
				},
			};
		}, { placement: "belowEditor" });
	};

	const command = async (args: string, ctx: ExtensionContext) => {
		if (!ctx.hasUI) { ctx.ui.notify("/btw requires interactive or RPC mode.", "warning"); return; }
		let text = args.trim();
		if (text === "help") { ctx.ui.notify("/btw [message] · /btw new [message] · /btw cancel · /btw close · Ctrl+/ cycles threads", "info"); return; }
		if (text === "cancel") { await abort(); return; }
		if (text === "close") {
			const link = side?.link ?? findSideLink(ctx);
			await stop(ctx);
			if (link) pi.appendEntry(SIDE_LINK, { ...link, closed: true });
			return;
		}
		if (text === "new" || text.startsWith("new ")) {
			await stop(ctx);
			pi.appendEntry(SIDE_LINK, { version: 2, id: "", closed: true });
			text = text.slice(3).trim();
		}
		await ensure(ctx);
		show(ctx);
		if (text) submit(text, ctx);
		else if (ctx.mode === "rpc") ctx.ui.notify("Side thread open. Send a message with /btw <message>.", "info");
	};

	pi.registerCommand("btw", { description: "Open a side thread (/btw help); Ctrl+/ cycles threads", handler: async (args, ctx) => {
		try { await command(args, ctx); } catch (error) { report(ctx, error); }
	} });
	switcher.register("side", {
		list: (ctx) => side || findSideLink(ctx) ? ["side"] : [],
		hide: () => { if (viewContext) setVisible(false, viewContext); },
		blocked: () => dialogs > 0,
		show: async (_id, ctx, stillCurrent) => {
			await ensure(ctx);
			if (stillCurrent()) show(ctx);
		},
	});
	pi.on("agent_start", (_event, ctx) => refresh(ctx));
	pi.on("agent_settled", (_event, ctx) => refresh(ctx));
	// Main-thread permission/input dialogs need to remain reachable from side view.
	pi.on("ui_prompt_start", () => { dialogs++; overlay?.setHidden(true); });
	pi.on("ui_prompt_end", (_event, ctx) => { dialogs = Math.max(0, dialogs - 1); setVisible(visible, ctx); });
	pi.on("session_shutdown", (_event, ctx) => stop(ctx));
	pi.on("session_before_tree", (_event, ctx) => stop(ctx));
}
