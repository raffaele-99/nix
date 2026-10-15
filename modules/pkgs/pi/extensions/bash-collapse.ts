import type { BashToolInput, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";

const PROMPT = "$ ";
const ELLIPSIS = "…";

type ToolResult = { content: { type: string; text?: string }[] };
type ExitStatus = { label: string; failed: boolean };

const FAILURE_LABELS: [pattern: RegExp, toLabel: (match: RegExpMatchArray) => string][] = [
  [/Command exited with code (-?\d+)\s*$/, (match) => `exit ${match[1]}`],
  [/Command aborted\s*$/, () => "aborted"],
  [/Command timed out after \d+ seconds\s*$/, () => "timed out"],
];

const graphemes = new Intl.Segmenter();

const noOutput: Component = { render: () => [], invalidate() {} };

function singleLine(renderLine: (width: number) => string): Component {
  return { render: (width) => [renderLine(width)], invalidate() {} };
}

function truncateWithoutStyleReset(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;

  const textWidth = maxWidth - visibleWidth(ELLIPSIS);
  let kept = "";
  let keptWidth = 0;
  for (const { segment } of graphemes.segment(text)) {
    const segmentWidth = visibleWidth(segment);
    if (keptWidth + segmentWidth > textWidth) break;
    kept += segment;
    keptWidth += segmentWidth;
  }
  return kept + ELLIPSIS;
}

function outputText(result: ToolResult): string {
  return result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

function exitStatus(result: ToolResult, isError: boolean): ExitStatus {
  if (!isError) return { label: "exit 0", failed: false };

  const output = outputText(result);
  for (const [pattern, toLabel] of FAILURE_LABELS) {
    const match = output.match(pattern);
    if (match) return { label: toLabel(match), failed: true };
  }
  return { label: "failed", failed: true };
}

function collapsedCall(theme: Theme, command: string, timeout: number | undefined): Component {
  const [firstLine, ...extraLines] = command.trim().replaceAll("\t", "   ").split(/\r?\n/);
  const notes = [
    extraLines.length > 0 ? `+${extraLines.length} ${extraLines.length === 1 ? "line" : "lines"}` : "",
    timeout ? `timeout ${timeout}s` : "",
  ].filter(Boolean);
  const suffix = notes.map((note) => ` (${note})`).join("");

  return singleLine((width) => {
    const shownCommand = truncateWithoutStyleReset(firstLine, width - visibleWidth(PROMPT + suffix));
    return theme.fg("toolTitle", theme.bold(PROMPT + shownCommand)) + theme.fg("muted", suffix);
  });
}

function collapsedResult(theme: Theme, status: ExitStatus): Component {
  return singleLine((width) =>
    theme.fg(status.failed ? "error" : "success", truncateWithoutStyleReset(status.label, width)),
  );
}

function renderAndRemember(
  state: Record<string, Component | undefined>,
  slot: "fullCall" | "fullResult",
  render: (previous: Component | undefined) => Component,
): Component {
  const component = render(state[slot]);
  state[slot] = component;
  return component;
}

export default function (pi: ExtensionAPI) {
  pi.registerToolRenderer((toolName, next) => {
    const renderers = next();
    if (toolName !== "bash" || !renderers?.renderCall || !renderers.renderResult) return renderers;
    const { renderCall: renderFullCall, renderResult: renderFullResult } = renderers;

    return {
      ...renderers,
      renderCall(args, theme, context) {
        const fullCall = renderAndRemember(context.state, "fullCall", (lastComponent) =>
          renderFullCall(args, theme, { ...context, lastComponent }),
        );

        const { command, timeout } = (args ?? {}) as Partial<BashToolInput>;
        if (context.expanded || typeof command !== "string" || !command.trim()) return fullCall;
        return collapsedCall(theme, command, timeout);
      },
      renderResult(result, options, theme, context) {
        const fullResult = renderAndRemember(context.state, "fullResult", (lastComponent) =>
          renderFullResult(result, options, theme, { ...context, lastComponent }),
        );

        if (context.expanded) return fullResult;
        if (options.isPartial) return noOutput;
        return collapsedResult(theme, exitStatus(result, context.isError));
      },
    };
  });
}
