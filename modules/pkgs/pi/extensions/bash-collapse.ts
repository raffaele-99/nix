import type { BashToolInput, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PROMPT = "$ ";

function collapsedCall(theme: Theme, command: string, timeout: number | undefined): Component {
  const [firstLine, ...hiddenLines] = command.trim().replaceAll("\t", "   ").split(/\r?\n/);

  const notes: string[] = [];
  if (hiddenLines.length > 0) notes.push(`+${hiddenLines.length} ${hiddenLines.length === 1 ? "line" : "lines"}`);
  if (timeout) notes.push(`timeout ${timeout}s`);
  const suffix = notes.map((note) => ` (${note})`).join("");

  return {
    render(width) {
      const shownCommand = truncateToWidth(firstLine, width - visibleWidth(PROMPT + suffix), "…");
      const line = theme.fg("toolTitle", theme.bold(PROMPT + shownCommand)) + theme.fg("muted", suffix);
      return [truncateToWidth(line, width, "…")];
    },
    invalidate() {},
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerToolRenderer((toolName, next) => {
    const renderers = next();
    const renderFullCall = renderers?.renderCall;
    if (toolName !== "bash" || !renderFullCall) return renderers;

    return {
      ...renderers,
      renderCall(args, theme, context) {
        const fullCall = renderFullCall(args, theme, { ...context, lastComponent: context.state.fullCall });
        context.state.fullCall = fullCall;

        const { command, timeout } = (args ?? {}) as Partial<BashToolInput>;
        if (context.expanded || typeof command !== "string" || !command.trim()) return fullCall;
        return collapsedCall(theme, command, timeout);
      },
    };
  });
}
