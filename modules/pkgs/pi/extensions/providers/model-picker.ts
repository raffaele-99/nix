import type { Theme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, SelectList, Text, truncateToWidth, type Component, type Focusable, type KeybindingsManager, type SelectItem } from "@earendil-works/pi-tui";

export class ModelPicker implements Component, Focusable {
	private readonly input: Input;
	private readonly items: SelectItem[];
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: (value: string | undefined) => void;
	private readonly title: string;
	private list: SelectList;

	get focused(): boolean { return this.input.focused; }
	set focused(value: boolean) { this.input.focused = value; }

	constructor(
		items: Pick<SelectItem, "value" | "description">[],
		selected: string,
		theme: Theme,
		keys: KeybindingsManager,
		requestRender: () => void,
		done: (value: string | undefined) => void,
		title = "Subagent model",
	) {
		this.title = title;
		this.items = items.map((item) => ({ ...item, label: item.value }));
		this.theme = theme;
		this.keys = keys;
		this.requestRender = requestRender;
		this.done = done;
		this.input = new Input({ prompt: "Search: ", placeholder: "Type a model name or provider", placeholderStyle: (text) => theme.fg("dim", text) });
		this.list = this.createList(this.items);
		this.list.setSelectedIndex(items.findIndex((item) => item.value === selected));
	}

	private createList(items: SelectItem[]): SelectList {
		const list = new SelectList(items, 10, {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: () => this.theme.fg("warning", "  No matching models or providers"),
		}, { minPrimaryColumnWidth: 32, maxPrimaryColumnWidth: 64 });
		list.onSelect = (item) => this.done(item.value);
		list.onCancel = () => this.done(undefined);
		return list;
	}

	handleInput(data: string): void {
		if ((["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const).some((key) => this.keys.matches(data, key))) {
			this.list.handleInput(data);
		} else {
			const previous = this.input.getValue();
			this.input.handleInput(data);
			const query = this.input.getValue();
			if (query !== previous) this.list = this.createList(fuzzyFilter(this.items, query, (item) => `${item.value} ${item.description ?? ""}`));
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const up = this.keys.getKeys("tui.select.up").join("/");
		const down = this.keys.getKeys("tui.select.down").join("/");
		const confirm = this.keys.getKeys("tui.select.confirm").join("/");
		const cancel = this.keys.getKeys("tui.select.cancel").join("/");
		return [
			...new Text(this.theme.fg("accent", this.title), 0, 0).render(width),
			...this.input.render(width), "",
			...this.list.render(width).map((line) => truncateToWidth(line, width)), "",
			...new Text(this.theme.fg("dim", `Type to filter · ${up}/${down} navigate · ${confirm} select · ${cancel} cancel`), 0, 0).render(width),
		];
	}

	invalidate(): void {
		this.input.invalidate();
		this.list.invalidate();
	}
}
