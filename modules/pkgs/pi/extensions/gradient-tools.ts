import { type ExtensionAPI, Theme, type ThemeBg, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, type Color, colorToHex, mixColors, visibleWidth } from "@earendil-works/pi-tui";

const ORIGINAL_RENDER = Symbol.for("gradient-tools.originalRender");
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

type GradientTool = {
  isPartial: boolean;
  result?: { isError?: boolean };
  toolDefinition?: { renderShell?: string };
  outputPad?: number;
  selfRenderHeight?: number;
  render(width: number): string[];
};

type BackgroundChange = "set" | "cleared" | "unchanged";

const graphemes = new Intl.Segmenter();
const ramps = new Map<string, string[]>();
const paintCaches = new WeakMap<object, { ramp: string[]; lines: Map<string, string> }>();

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

export default function (pi: ExtensionAPI) {
  let currentTheme: () => Theme | undefined = () => undefined;

  pi.registerToolRenderer((_toolName, next) => {
    const renderers = next();
    return renderers && { ...renderers, renderShell: "self" };
  });

  pi.on("session_start", (_event, ctx) => {
    currentTheme = () => {
      try {
        return ctx.ui.theme;
      } catch {
        return undefined;
      }
    };
  });

  const prototype = ToolExecutionComponent.prototype as unknown as Record<symbol, unknown> & GradientTool;
  const originalRender = (prototype[ORIGINAL_RENDER] ?? prototype.render) as GradientTool["render"];
  prototype[ORIGINAL_RENDER] = originalRender;

  prototype.render = function (this: GradientTool, width: number): string[] {
    const theme = currentTheme();
    const pad = this.outputPad ?? 1;
    if (!theme || this.toolDefinition?.renderShell !== "self" || width <= 2 * pad + 1) {
      return originalRender.call(this, width);
    }

    const lines = originalRender.call(this, width - 2 * pad);
    const hasSpacerLine = lines[0] === "";
    const contentStart = hasSpacerLine ? 1 : 0;
    const contentEnd = contentStart + (this.selfRenderHeight ?? lines.length);
    const ramp = fadingBackgroundPerColumn(theme, statusBackground(this), width);
    const previous = paintCaches.get(this);
    const cached = previous?.ramp === ramp ? previous.lines : undefined;
    const painted = new Map<string, string>();
    const padding = " ".repeat(pad);

    const result = lines.map((line, index) => {
      const isToolContent = index >= contentStart && index < contentEnd;
      if (!isToolContent || GRAPHICS_LINE.test(line)) return line;
      const output = cached?.get(line) ?? paintBehindContent(padding + line, width, ramp);
      painted.set(line, output);
      return output;
    });
    paintCaches.set(this, { ramp, lines: painted });
    return result;
  };
}
