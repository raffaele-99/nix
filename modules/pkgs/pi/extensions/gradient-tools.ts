import { type ExtensionAPI, Theme, type ThemeBg, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, type Color, colorToHex, mixColors, visibleWidth } from "@earendil-works/pi-tui";

const ORIGINAL_RENDER = Symbol.for("gradient-tools.originalRender");
const RESET_BACKGROUND = "\x1b[49m";
// CSI sequences, and OSC/APC/DCS strings terminated by BEL or ST.
const ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]_P^X][^\x07\x1b]*(?:\x07|\x1b\\))/y;
const GRAPHICS_LINE = /\x1b_G|\x1b\]1337;/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** Tint opacity at a position 0 (left edge) to 1 (right edge). */
const fade = (t: number) => (1 - t) ** 1.6;

type GradientTool = {
  isPartial: boolean;
  result?: { isError?: boolean };
  toolDefinition?: { renderShell?: string };
  outputPad?: number;
  selfRenderHeight?: number;
  render(width: number): string[];
};

const graphemes = new Intl.Segmenter();
const ramps = new Map<string, string[]>();
const paintCaches = new WeakMap<object, { ramp: string[]; lines: Map<string, string> }>();

// Theme resolves tokens set to "" from the terminal's reported default colors (or a light/dark guess),
// so a theme whose only background is "" reads the real terminal background.
let backgroundProbe: Theme | undefined;
function terminalBackground(): Color {
  backgroundProbe ??= new Theme(
    { text: "", muted: "", thinkingXhigh: "" } as never,
    { selectedBg: "" } as never,
    "truecolor",
  );
  return backgroundProbe.colors.selectedBg;
}

function statusBackground(tool: GradientTool): ThemeBg {
  if (tool.isPartial) return "toolPendingBg";
  return tool.result?.isError ? "toolErrorBg" : "toolSuccessBg";
}

/** Background escape per column, fading from the status tint into the terminal background. */
function fadeRamp(theme: Theme, token: ThemeBg, width: number): string[] {
  const mode = theme.getColorMode();
  const tint = theme.colors[token];
  const background = terminalBackground();
  const key = `${colorToHex(tint)}>${colorToHex(background)}|${width}|${mode}`;
  const cached = ramps.get(key);
  if (cached) return cached;

  // 256 colors cannot express a smooth fade; use the plain tint rather than visible bands.
  const ramp =
    mode === "truecolor"
      ? Array.from({ length: width }, (_, column) =>
          backgroundAnsi(mixColors(background, tint, fade(column / Math.max(1, width - 1)), "srgb"), mode),
        )
      : Array<string>(width).fill(theme.getBgAnsi(token));
  if (ramps.size > 64) ramps.clear();
  ramps.set(key, ramp);
  return ramp;
}

/** Whether an SGR sequence sets (true) or clears (false) the background, or leaves it alone. */
function backgroundChange(sgr: string): boolean | undefined {
  const params = sgr.slice(2, -1);
  if (params === "") return false;
  let change: boolean | undefined;
  const parts = params.split(";");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const code = Number.parseInt(part, 10) || 0;
    if (code === 0 || code === 49) change = false;
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107) || code === 48) change = true;
    // Skip extended color arguments so 38;5;41 is not read as a background.
    if ((code === 38 || code === 48 || code === 58) && !part.includes(":")) {
      i += parts[i + 1] === "5" ? 2 : parts[i + 1] === "2" ? 4 : 0;
    }
  }
  return change;
}

/** Paint the ramp under every cell of the line, padded to the full width. Content backgrounds win. */
function paint(line: string, width: number, ramp: string[]): string {
  let out = "";
  let column = 0;
  let current: string | undefined;
  let ownBackground = false;

  const cell = (text: string, cellWidth: number) => {
    if (!ownBackground && cellWidth > 0) {
      const bg = ramp[Math.min(column, ramp.length - 1)];
      if (bg !== current) out += current = bg;
    }
    out += text;
    column += cellWidth;
  };

  let i = 0;
  while (i < line.length) {
    if (line.charCodeAt(i) === 0x1b) {
      ESCAPE.lastIndex = i;
      const code = ESCAPE.exec(line)?.[0] ?? "\x1b";
      out += code;
      i += code.length;
      if (code.startsWith("\x1b[") && code.endsWith("m")) {
        const change = backgroundChange(code);
        if (change !== undefined) {
          ownBackground = change;
          current = undefined;
        }
      }
      continue;
    }

    let end = line.indexOf("\x1b", i);
    if (end === -1) end = line.length;
    const text = line.slice(i, end).replaceAll("\t", "   ");
    i = end;
    if (PRINTABLE_ASCII.test(text)) {
      for (const char of text) cell(char, 1);
    } else {
      for (const { segment } of graphemes.segment(text)) cell(segment, visibleWidth(segment));
    }
  }

  ownBackground = false;
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
    // Line 0 is the blank spacer above the tool; images follow the self-rendered content.
    const start = lines[0] === "" ? 1 : 0;
    const end = start + (this.selfRenderHeight ?? lines.length);
    const ramp = fadeRamp(theme, statusBackground(this), width);
    const previous = paintCaches.get(this);
    const cached = previous?.ramp === ramp ? previous.lines : undefined;
    const painted = new Map<string, string>();
    const padding = " ".repeat(pad);

    const result = lines.map((line, index) => {
      if (index < start || index >= end || GRAPHICS_LINE.test(line)) return line;
      const output = cached?.get(line) ?? paint(padding + line, width, ramp);
      painted.set(line, output);
      return output;
    });
    paintCaches.set(this, { ramp, lines: painted });
    return result;
  };
}
