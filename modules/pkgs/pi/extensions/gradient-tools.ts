import {
  AssistantMessageComponent,
  type ExtensionAPI,
  type ExtensionUIContext,
  Theme,
  type ThemeBg,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  backgroundAnsi,
  Box,
  type Color,
  Container,
  colorToHex,
  type Component,
  MouseRegion,
  mixColors,
  ScrollView,
  Spacer,
  type TuiMouseEvent,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const ORIGINAL_RENDER = Symbol.for("gradient-tools.originalRender");
const ORIGINAL_HANDLE_MOUSE = Symbol.for("gradient-tools.originalHandleMouse");
const ORIGINAL_CONTAINER_RENDER = Symbol.for("gradient-tools.originalContainerRender");
const ORIGINAL_CONTAINER_HANDLE_MOUSE = Symbol.for("gradient-tools.originalContainerHandleMouse");
const ORIGINAL_UPDATE_LAYOUT = Symbol.for("gradient-tools.originalUpdateLayout");
const RESET_BACKGROUND = "\x1b[49m";
const CSI = String.raw`\[[0-?]*[ -/]*[@-~]`;
const STRING_COMMAND = String.raw`[\]_P^X][^\x07\x1b]*`;
const BEL_OR_ST = String.raw`(?:\x07|\x1b\\)`;
const ESCAPE_SEQUENCE = new RegExp(String.raw`\x1b(?:${CSI}|${STRING_COMMAND}${BEL_OR_ST})`, "y");
const GRAPHICS_LINE = /\x1b_G|\x1b\]1337;/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const TAB_AS_SPACES = "   ";

const FADE_EXPONENT = 1.6;
const MAX_CACHED_RAMPS = 64;
const TERMINAL_DEFAULT = "";
const EXTENDED_COLOR_CODES = new Set([38, 48, 58]);

const RESULT_SEPARATOR = " · ";
const ELLIPSIS = "…";
const MIN_CALL_WIDTH = 20;
const PADDING_ROWS = 1;
const ROW_HEIGHT_IN_COLUMNS = 2;
const PADDING_COLUMNS = PADDING_ROWS * ROW_HEIGHT_IN_COLUMNS;

const COLLAPSED_GROUP = "▸";
const EXPANDED_GROUP = "▾";
const RESPONSE_ZONE_START = "\x1b]133;A\x07";
const RESPONSE_ZONE_END = "\x1b]133;B\x07\x1b]133;C\x07";

type GradientTool = Component & {
  isPartial: boolean;
  expanded: boolean;
  result?: { isError?: boolean };
  toolDefinition?: { renderShell?: string };
  selfRenderHeight?: number;
  selfRenderContainer: Container;
  handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]>;
};

type TranscriptItem =
  | { kind: "tool"; component: GradientTool; message?: undefined }
  | { kind: "thought" | "spacer" | "content"; component: Component; message?: AssistantMessageComponent };

type WorkRun = { start: number; end: number; trailing: boolean };

type ToolGroup = WorkRun & { tools: GradientTool[]; thoughts: number };

type PaddedBlock = { top: number; contentHeight: number; contentWidth: number };

type RenderContext = { lastComponent: Component | undefined };

type BackgroundChange = "set" | "cleared" | "unchanged";

const graphemes = new Intl.Segmenter();
const ramps = new Map<string, string[]>();
const paintCaches = new WeakMap<object, { ramp: string[]; lines: Map<string, string> }>();
const callLineCaches = new WeakMap<object, { key: string; line: string | undefined }>();
const paddedBlocks = new WeakMap<object, PaddedBlock>();
const boxContents = new WeakMap<Box, Component>();
const unboxedBoxes = new WeakMap<Component, Box>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function withoutBox(component: Component): Component {
  if (!(component instanceof Box)) return component;
  const existing = boxContents.get(component);
  if (existing) return existing;
  const contents: Component = {
    render: (width) => component.children.flatMap((child) => child.render(width)),
    invalidate: () => component.invalidate(),
  };
  boxContents.set(component, contents);
  unboxedBoxes.set(contents, component);
  return contents;
}

function withOriginalLastComponent<Context extends RenderContext>(context: Context): Context {
  const box = context.lastComponent && unboxedBoxes.get(context.lastComponent);
  return box ? { ...context, lastComponent: box } : context;
}

function tintStrength(fractionAcross: number): number {
  return (1 - fractionAcross) ** FADE_EXPONENT;
}

let terminalDefaultsTheme: Theme | undefined;
function terminalDefaultBackground(): Color {
  terminalDefaultsTheme ??= new Theme(
    { text: TERMINAL_DEFAULT, muted: TERMINAL_DEFAULT, thinkingXhigh: TERMINAL_DEFAULT } as never,
    { selectedBg: TERMINAL_DEFAULT } as never,
    "truecolor",
  );
  return terminalDefaultsTheme.colors.selectedBg;
}

function statusBackground(tool: GradientTool): ThemeBg {
  if (tool.isPartial) return "toolPendingBg";
  return tool.result?.isError ? "toolErrorBg" : "toolSuccessBg";
}

function fadingBackgroundPerColumn(theme: Theme, token: ThemeBg, width: number): string[] {
  const mode = theme.getColorMode();
  const tint = theme.colors[token];
  const background = terminalDefaultBackground();
  const key = `${colorToHex(tint)}>${colorToHex(background)}|${width}|${mode}`;
  const cached = ramps.get(key);
  if (cached) return cached;

  const supportsSmoothFade = mode === "truecolor";
  const ramp = supportsSmoothFade
    ? Array.from({ length: width }, (_, column) =>
        backgroundAnsi(mixColors(background, tint, tintStrength(column / Math.max(1, width - 1)), "srgb"), mode),
      )
    : Array<string>(width).fill(theme.getBgAnsi(token));
  if (ramps.size > MAX_CACHED_RAMPS) ramps.clear();
  ramps.set(key, ramp);
  return ramp;
}

function isBackgroundSet(code: number): boolean {
  return (code >= 40 && code <= 47) || (code >= 100 && code <= 107) || code === 48;
}

function isBackgroundReset(code: number): boolean {
  return code === 0 || code === 49;
}

function extendedColorArgumentCount(colorSpace: string | undefined): number {
  if (colorSpace === "5") return 2;
  if (colorSpace === "2") return 4;
  return 0;
}

function sgrBackgroundChange(sgr: string): BackgroundChange {
  const params = sgr.slice(2, -1);
  if (params === "") return "cleared";
  let change: BackgroundChange = "unchanged";
  const parts = params.split(";");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const code = Number.parseInt(part, 10) || 0;
    if (isBackgroundReset(code)) change = "cleared";
    else if (isBackgroundSet(code)) change = "set";
    const hasSemicolonArguments = EXTENDED_COLOR_CODES.has(code) && !part.includes(":");
    if (hasSemicolonArguments) i += extendedColorArgumentCount(parts[i + 1]);
  }
  return change;
}

function isSgr(sequence: string): boolean {
  return sequence.startsWith("\x1b[") && sequence.endsWith("m");
}

function paintBehindContent(line: string, width: number, ramp: string[]): string {
  let out = "";
  let column = 0;
  let current: string | undefined;
  let contentHasBackground = false;

  const cell = (text: string, cellWidth: number) => {
    if (!contentHasBackground && cellWidth > 0) {
      const bg = ramp[Math.min(column, ramp.length - 1)];
      if (bg !== current) out += current = bg;
    }
    out += text;
    column += cellWidth;
  };

  let i = 0;
  while (i < line.length) {
    if (line.charCodeAt(i) === 0x1b) {
      ESCAPE_SEQUENCE.lastIndex = i;
      const sequence = ESCAPE_SEQUENCE.exec(line)?.[0] ?? "\x1b";
      out += sequence;
      i += sequence.length;
      const change = isSgr(sequence) ? sgrBackgroundChange(sequence) : "unchanged";
      if (change !== "unchanged") {
        contentHasBackground = change === "set";
        current = undefined;
      }
      continue;
    }

    let end = line.indexOf("\x1b", i);
    if (end === -1) end = line.length;
    const text = line.slice(i, end).replaceAll("\t", TAB_AS_SPACES);
    i = end;
    if (PRINTABLE_ASCII.test(text)) {
      for (const char of text) cell(char, 1);
    } else {
      for (const { segment } of graphemes.segment(text)) cell(segment, visibleWidth(segment));
    }
  }

  contentHasBackground = false;
  while (column < width) cell(" ", 1);
  return out + RESET_BACKGROUND;
}

function paintBlock(owner: object, content: string[], width: number, ramp: string[]): string[] {
  const previous = paintCaches.get(owner);
  const cached = previous?.ramp === ramp ? previous.lines : undefined;
  const painted = new Map<string, string>();
  const leftPadding = " ".repeat(PADDING_COLUMNS);
  const paint = (line: string) => {
    if (GRAPHICS_LINE.test(line)) return line;
    const output = cached?.get(line) ?? paintBehindContent(leftPadding + line, width, ramp);
    painted.set(line, output);
    return output;
  };

  const paddingRows = Array<string>(PADDING_ROWS).fill("");
  const block = [...paddingRows, ...content, ...paddingRows].map(paint);
  paintCaches.set(owner, { ramp, lines: painted });
  return block;
}

function isBlank(line: string): boolean {
  return visibleWidth(line.replace(/\s/g, "")) === 0;
}

function trimTrailingSpaces(line: string): string {
  return line.replace(/ +$/, "");
}

function fitToWidth(call: Component, line: string, width: number): string {
  const trimmed = trimTrailingSpaces(line);
  if (visibleWidth(trimmed) <= width) return trimmed;
  const narrower = call.render(width).map(trimTrailingSpaces);
  if (narrower.length === 1 && visibleWidth(narrower[0]) <= width) return narrower[0];
  return truncateToWidth(trimmed, width, ELLIPSIS);
}

function callLineWithResult(tool: GradientTool, theme: Theme, width: number): string | undefined {
  const [call, result] = tool.selfRenderContainer.children;
  if (!call || !result) return undefined;
  const callLines = call.render(width);
  const resultLines = result.render(width).filter((line) => !isBlank(line));
  if (callLines.length !== 1 || resultLines.length !== 1) return undefined;

  const key = `${width}\n${callLines[0]}\n${resultLines[0]}`;
  const cached = callLineCaches.get(tool);
  if (cached?.key === key) return cached.line;

  const suffix = theme.fg("dim", RESULT_SEPARATOR) + trimTrailingSpaces(resultLines[0]);
  const callWidth = width - visibleWidth(suffix);
  const line = callWidth < MIN_CALL_WIDTH ? undefined : fitToWidth(call, callLines[0], callWidth) + suffix;
  callLineCaches.set(tool, { key, line });
  return line;
}

function isGradientTool(component: Component): component is GradientTool {
  return (
    component instanceof ToolExecutionComponent &&
    (component as unknown as GradientTool).toolDefinition?.renderShell === "self"
  );
}

function holdsGradientTools(container: Container): boolean {
  return container.children.some(isGradientTool);
}

function messageParts(message: AssistantMessageComponent): Component[] | undefined {
  const { contentContainer } = message as unknown as { contentContainer?: unknown };
  return contentContainer instanceof Container ? contentContainer.children : undefined;
}

function partKind(part: Component): "thought" | "spacer" | "content" {
  if (part instanceof MouseRegion) return "thought";
  return part instanceof Spacer ? "spacer" : "content";
}

function messageItems(message: AssistantMessageComponent): TranscriptItem[] | undefined {
  return messageParts(message)?.map((part) => ({ kind: partKind(part), component: part, message }));
}

function itemsOf(child: Component): TranscriptItem[] {
  if (isGradientTool(child)) return [{ kind: "tool", component: child }];
  const parts = child instanceof AssistantMessageComponent ? messageItems(child) : undefined;
  return parts ?? [{ kind: child instanceof Spacer ? "spacer" : "content", component: child }];
}

function isWork(item: TranscriptItem): boolean {
  return item.kind === "tool" || item.kind === "thought";
}

function isGap(item: TranscriptItem, width: number): boolean {
  return item.kind === "spacer" || (item.kind === "content" && item.component.render(width).length === 0);
}

function runStart(items: TranscriptItem[], firstWork: number, boundary: number, width: number): number {
  let start = firstWork;
  while (start > boundary && isGap(items[start - 1], width)) start--;
  return start;
}

function runEnd(items: TranscriptItem[], firstWork: number, width: number): Omit<WorkRun, "start"> {
  let end = firstWork;
  for (let next = firstWork + 1; next < items.length; next++) {
    if (isWork(items[next])) end = next;
    else if (!isGap(items[next], width)) return { end, trailing: false };
  }
  return { end, trailing: true };
}

function workRuns(items: TranscriptItem[], width: number): WorkRun[] {
  const runs: WorkRun[] = [];
  for (let index = 0; index < items.length; index++) {
    if (!isWork(items[index])) continue;
    const boundary = (runs.at(-1)?.end ?? -1) + 1;
    const run = { start: runStart(items, index, boundary, width), ...runEnd(items, index, width) };
    runs.push(run);
    index = run.end;
  }
  return runs;
}

function toolGroups(items: TranscriptItem[], width: number): ToolGroup[] {
  return workRuns(items, width).flatMap((run) => {
    const members = items.slice(run.start, run.end + 1);
    const tools = members.flatMap((item) => (item.kind === "tool" ? [item.component] : []));
    const thoughts = members.filter((item) => item.kind === "thought").length;
    return tools.length === 0 ? [] : [{ ...run, tools, thoughts }];
  });
}

function spacedFromHeader(members: TranscriptItem[]): TranscriptItem[] {
  const startsFlush = members[0]?.kind === "thought";
  return startsFlush ? [{ kind: "spacer", component: new Spacer(1) }, ...members] : members;
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function timesOf(count: number): string {
  if (count === 1) return "once";
  if (count === 2) return "twice";
  return `${count} times`;
}

function groupActivity(group: ToolGroup): string {
  const calls = `made ${countOf(group.tools.length, "tool call")}`;
  return group.thoughts === 0 ? calls : `${calls}, thought ${timesOf(group.thoughts)}`;
}

function failedCalls(group: ToolGroup): number {
  return group.tools.filter((tool) => !tool.isPartial && tool.result?.isError).length;
}

function groupSummary(group: ToolGroup, theme: Theme, expanded: boolean): string {
  const marker = theme.fg("dim", expanded ? EXPANDED_GROUP : COLLAPSED_GROUP);
  const failures = failedCalls(group);
  const status = failures === 0 ? "" : theme.fg("dim", RESULT_SEPARATOR) + theme.fg("error", `${failures} failed`);
  return `${marker} ${theme.fg("toolTitle", theme.bold(groupActivity(group)))}${status}`;
}

function groupBackground(group: ToolGroup, agentRunning: boolean): ThemeBg {
  const working = group.tools.some((tool) => tool.isPartial) || (agentRunning && group.trailing);
  return working ? "toolPendingBg" : "toolSuccessBg";
}

function isFinalResponse(message: AssistantMessageComponent): boolean {
  return (message as unknown as { hasToolCalls?: boolean }).hasToolCalls === false;
}

class ResponseZone extends MouseRegion {
  private readonly opens: boolean;
  private readonly closes: boolean;

  constructor(part: Component, opens: boolean, closes: boolean) {
    super(part, () => undefined);
    this.opens = opens;
    this.closes = closes;
  }

  override render(width: number): string[] {
    const lines = [...super.render(width)];
    if (lines.length === 0) return lines;
    if (this.opens) lines[0] = RESPONSE_ZONE_START + lines[0];
    if (this.closes) lines[lines.length - 1] = RESPONSE_ZONE_END + lines[lines.length - 1];
    return lines;
  }
}

function withResponseZones(shown: TranscriptItem[]): Component[] {
  const firstShown = new Map<AssistantMessageComponent, number>();
  const lastShown = new Map<AssistantMessageComponent, number>();
  shown.forEach(({ message }, index) => {
    if (!message || !isFinalResponse(message)) return;
    if (!firstShown.has(message)) firstShown.set(message, index);
    lastShown.set(message, index);
  });
  return shown.map(({ component, message }, index) => {
    const opens = message !== undefined && firstShown.get(message) === index;
    const closes = message !== undefined && lastShown.get(message) === index;
    return opens || closes ? new ResponseZone(component, opens, closes) : component;
  });
}

class GroupExpansion {
  private readonly choices = new WeakMap<object, { expanded: boolean; generation: number }>();
  private generation = 0;
  private toolsExpanded = false;

  follow(toolsExpanded: boolean): void {
    if (toolsExpanded === this.toolsExpanded) return;
    this.toolsExpanded = toolsExpanded;
    this.generation++;
  }

  isExpanded(group: object): boolean {
    const choice = this.choices.get(group);
    return choice?.generation === this.generation ? choice.expanded : this.toolsExpanded;
  }

  toggle(group: object): void {
    this.choices.set(group, { expanded: !this.isExpanded(group), generation: this.generation });
  }
}

class ToolGroupBlock implements Component {
  private theme: Theme | undefined;
  private summary = "";
  private background: ThemeBg = "toolSuccessBg";
  private readonly onClick: () => void;

  constructor(onClick: () => void) {
    this.onClick = onClick;
  }

  show(theme: Theme, summary: string, background: ThemeBg): this {
    this.theme = theme;
    this.summary = summary;
    this.background = background;
    return this;
  }

  render(width: number): string[] {
    if (!this.theme) return [];
    const line = truncateToWidth(this.summary, Math.max(1, width - 2 * PADDING_COLUMNS), ELLIPSIS);
    const ramp = fadingBackgroundPerColumn(this.theme, this.background, width);
    return ["", ...paintBlock(this, [line], width, ramp)];
  }

  handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
    const onSpacerLine = event.y === 0;
    if (onSpacerLine || event.type !== "click" || event.button !== "left") return undefined;
    this.onClick();
    return { handled: true };
  }

  invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
  let currentUi: () => ExtensionUIContext | undefined = () => undefined;
  let agentRunning = false;
  let transcriptViewport: { scrollView: ScrollView; contentHeight: number } | undefined;
  const currentTheme = () => currentUi()?.theme;
  const expansion = new GroupExpansion();
  const groupBlocks = new WeakMap<GradientTool, ToolGroupBlock>();
  const transcriptViews = new WeakMap<Container, Container>();

  pi.registerToolRenderer((_toolName, next) => {
    const renderers = next();
    if (!renderers) return renderers;
    const { renderCall, renderResult } = renderers;
    return {
      ...renderers,
      renderShell: "self",
      renderCall:
        renderCall &&
        ((args, theme, context) => withoutBox(renderCall(args, theme, withOriginalLastComponent(context)))),
      renderResult:
        renderResult &&
        ((result, options, theme, context) =>
          withoutBox(renderResult(result, options, theme, withOriginalLastComponent(context)))),
    };
  });

  pi.on("session_start", (_event, ctx) => {
    currentUi = () => {
      try {
        return ctx.ui;
      } catch {
        return undefined;
      }
    };
  });

  pi.on("agent_start", () => {
    agentRunning = true;
  });

  pi.on("agent_end", () => {
    agentRunning = false;
  });

  const groupBlock = (group: ToolGroup, theme: Theme, expanded: boolean): ToolGroupBlock => {
    const key = group.tools[0];
    let block = groupBlocks.get(key);
    if (!block) {
      block = new ToolGroupBlock(() => expansion.toggle(key));
      groupBlocks.set(key, block);
    }
    return block.show(theme, groupSummary(group, theme, expanded), groupBackground(group, agentRunning));
  };

  const transcriptSegments = (container: Container, width: number, theme: Theme): Component[] => {
    expansion.follow(currentUi()?.getToolsExpanded() ?? false);
    const items = container.children.flatMap(itemsOf);
    const groupsByStart = new Map(toolGroups(items, width).map((group) => [group.start, group]));
    const shown: TranscriptItem[] = [];
    for (let index = 0; index < items.length; index++) {
      const group = groupsByStart.get(index);
      if (!group) {
        shown.push(items[index]);
        continue;
      }
      const expanded = expansion.isExpanded(group.tools[0]);
      shown.push({ kind: "content", component: groupBlock(group, theme, expanded) });
      if (expanded) shown.push(...spacedFromHeader(items.slice(group.start, group.end + 1)));
      index = group.end;
    }
    return withResponseZones(shown);
  };

  const prototype = ToolExecutionComponent.prototype as unknown as Record<symbol, unknown> & GradientTool;
  const originalRender = (prototype[ORIGINAL_RENDER] ?? prototype.render) as GradientTool["render"];
  prototype[ORIGINAL_RENDER] = originalRender;

  const originalHandleMouse = (prototype[ORIGINAL_HANDLE_MOUSE] ?? prototype.handleMouse) as GradientTool["handleMouse"];
  prototype[ORIGINAL_HANDLE_MOUSE] = originalHandleMouse;

  prototype.render = function (this: GradientTool, width: number): string[] {
    const theme = currentTheme();
    paddedBlocks.delete(this);
    if (!theme || this.toolDefinition?.renderShell !== "self" || width <= 2 * PADDING_COLUMNS + 1) {
      return originalRender.call(this, width);
    }

    const contentWidth = width - 2 * PADDING_COLUMNS;
    const lines = originalRender.call(this, contentWidth);
    const hasSpacerLine = lines[0] === "";
    const contentStart = hasSpacerLine ? 1 : 0;
    const contentEnd = contentStart + (this.selfRenderHeight ?? lines.length);
    if (contentEnd === contentStart) return lines;

    const singleLine = this.expanded ? undefined : callLineWithResult(this, theme, contentWidth);
    const content = singleLine === undefined ? lines.slice(contentStart, contentEnd) : [singleLine];
    paddedBlocks.set(this, { top: contentStart, contentHeight: content.length, contentWidth });

    const ramp = fadingBackgroundPerColumn(theme, statusBackground(this), width);
    const block = paintBlock(this, content, width, ramp);
    return [...lines.slice(0, contentStart), ...block, ...lines.slice(contentEnd)];
  };

  prototype.handleMouse = function (this: GradientTool, event: TuiMouseEvent) {
    const block = paddedBlocks.get(this);
    if (!block) return originalHandleMouse.call(this, event);
    const row = event.y - block.top;
    if (row < 0 || row >= block.contentHeight + 2 * PADDING_ROWS) return undefined;
    return this.selfRenderContainer.handleMouse({
      ...event,
      x: clamp(event.x - PADDING_COLUMNS, 0, block.contentWidth - 1),
      y: clamp(row - PADDING_ROWS, 0, block.contentHeight - 1),
      width: block.contentWidth,
      height: block.contentHeight,
    });
  };

  const containerPrototype = Container.prototype as unknown as Record<symbol, unknown> & Container;
  const originalContainerRender = (containerPrototype[ORIGINAL_CONTAINER_RENDER] ??
    containerPrototype.render) as Container["render"];
  containerPrototype[ORIGINAL_CONTAINER_RENDER] = originalContainerRender;

  const originalContainerHandleMouse = (containerPrototype[ORIGINAL_CONTAINER_HANDLE_MOUSE] ??
    containerPrototype.handleMouse) as Container["handleMouse"];
  containerPrototype[ORIGINAL_CONTAINER_HANDLE_MOUSE] = originalContainerHandleMouse;

  containerPrototype.render = function (this: Container, width: number): string[] {
    const theme = holdsGradientTools(this) ? currentTheme() : undefined;
    if (!theme) {
      transcriptViews.delete(this);
      return originalContainerRender.call(this, width);
    }

    const view = transcriptViews.get(this) ?? new Container();
    transcriptViews.set(this, view);
    view.children = transcriptSegments(this, width, theme);
    return originalContainerRender.call(view, width);
  };

  const keepClickedLineOnScreen = (event: TuiMouseEvent, growth: number) => {
    const viewport = transcriptViewport;
    if (!viewport?.scrollView.isFollowingEnd) return;
    const { scrollView, contentHeight } = viewport;
    const followingScrollTop = Math.max(0, contentHeight + growth - scrollView.viewportHeight);
    const clickedRowAfterFollowing = event.screenY - (followingScrollTop - scrollView.scrollTop);
    if (clickedRowAfterFollowing < 0) scrollView.scrollTo(scrollView.scrollTop, { disableFollow: true });
  };

  containerPrototype.handleMouse = function (this: Container, event: TuiMouseEvent) {
    const view = transcriptViews.get(this);
    if (!view || event.type !== "click") return originalContainerHandleMouse.call(view ?? this, event);
    const heightBefore = this.render(event.width).length;
    const result = originalContainerHandleMouse.call(transcriptViews.get(this) ?? this, event);
    if (result) keepClickedLineOnScreen(event, this.render(event.width).length - heightBefore);
    return result;
  };

  const scrollViewPrototype = ScrollView.prototype as unknown as Record<symbol, unknown> & ScrollView;
  const originalUpdateLayout = (scrollViewPrototype[ORIGINAL_UPDATE_LAYOUT] ??
    scrollViewPrototype.updateLayout) as ScrollView["updateLayout"];
  scrollViewPrototype[ORIGINAL_UPDATE_LAYOUT] = originalUpdateLayout;

  scrollViewPrototype.updateLayout = function (
    this: ScrollView,
    contentHeight: number,
    viewportHeight: number,
    requestRender: () => void,
  ) {
    if (this.primary) transcriptViewport = { scrollView: this, contentHeight };
    originalUpdateLayout.call(this, contentHeight, viewportHeight, requestRender);
  };
}
