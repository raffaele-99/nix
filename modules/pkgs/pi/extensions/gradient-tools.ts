import { type ExtensionAPI, type Theme, type ThemeBg, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, type Color, mixColors, parseColor, type TerminalColorMode, visibleWidth } from "@earendil-works/pi-tui";

const FADE_COLUMNS = 40;
const ORIGINAL_RENDER = Symbol.for("gradient-tools.originalRender");
const TRAILING_BLANK = /^(.*?)((?:\x1b\[[0-9;]*m| )*)$/s;
const GRAPHICS_LINE = /\x1b_|\x1b\]1337/;
const RESET_BACKGROUND = "\x1b[49m";

const TERMINAL_BACKGROUNDS = { light: parseColor("#ffffff"), dark: parseColor("#000000") };

type RenderableToolExecution = {
  isPartial: boolean;
  result?: { isError?: boolean };
  render(width: number): string[];
};

const ramps = new Map<string, string[]>();

function statusBackground(tool: RenderableToolExecution): ThemeBg {
  if (tool.isPartial) return "toolPendingBg";
  return tool.result?.isError ? "toolErrorBg" : "toolSuccessBg";
}

function fadeRamp(theme: Theme, background: ThemeBg): string[] {
  const mode: TerminalColorMode = theme.getColorMode();
  const key = `${theme.getBgAnsi(background)}|${theme.appearance}`;
  const cached = ramps.get(key);
  if (cached) return cached;

  const tint: Color = theme.colors[background];
  const terminalBackground = TERMINAL_BACKGROUNDS[theme.appearance === "light" ? "light" : "dark"];
  const ramp = Array.from(
    { length: FADE_COLUMNS },
    (_, column) => `${backgroundAnsi(mixColors(tint, terminalBackground, column / FADE_COLUMNS), mode)} `,
  );
  ramps.set(key, ramp);
  return ramp;
}

function fadeAfterLastCharacter(line: string, width: number, ramp: string[]): string {
  if (GRAPHICS_LINE.test(line)) return line;

  const [, content, trailing] = line.match(TRAILING_BLANK) ?? [];
  if (content === undefined || visibleWidth(content) === 0) return line;

  const openStyles = trailing.replaceAll(" ", "");
  const fadeWidth = Math.min(FADE_COLUMNS, width - visibleWidth(content));
  return `${content}${openStyles}${ramp.slice(0, fadeWidth).join("")}${RESET_BACKGROUND}`;
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

  const prototype = ToolExecutionComponent.prototype as unknown as Record<symbol, unknown> & RenderableToolExecution;
  const originalRender = (prototype[ORIGINAL_RENDER] ?? prototype.render) as RenderableToolExecution["render"];
  prototype[ORIGINAL_RENDER] = originalRender;

  prototype.render = function (this: RenderableToolExecution, width: number): string[] {
    const lines = originalRender.call(this, width);
    const theme = currentTheme();
    if (!theme) return lines;

    const ramp = fadeRamp(theme, statusBackground(this));
    return lines.map((line) => fadeAfterLastCharacter(line, width, ramp));
  };
}
