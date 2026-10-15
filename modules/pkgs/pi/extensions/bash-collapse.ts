import type { BashToolInput, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";

const PROMPT = "$ ";

const segmenter = new Intl.Segmenter();

function truncatePlain(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const w = visibleWidth(segment);
    if (used + w > maxWidth - 1) break;
    out += segment;
    used += w;
  }
  return `${out}…`;
}

function collapsedCall(theme: Theme, command: string, timeout: number | undefined): Component {
  const [firstLine, ...hiddenLines] = command.trim().replaceAll("\t", "   ").split(/\r?\n/);

  const notes: string[] = [];
  if (hiddenLines.length > 0) notes.push(`+${hiddenLines.length} ${hiddenLines.length === 1 ? "line" : "lines"}`);
  if (timeout) notes.push(`timeout ${timeout}s`);
  const suffix = notes.map((note) => ` (${note})`).join("");

  return {
    render(width) {
      const shownCommand = truncatePlain(firstLine, width - visibleWidth(PROMPT + suffix));
      return [theme.fg("toolTitle", theme.bold(PROMPT + shownCommand)) + theme.fg("muted", suffix)];
    },
    invalidate() {},
  };
}

const emptyResult: Component = { render: () => [], invalidate() {} };

function statusLabel(result: { content: { type: string; text?: string }[] }, isError: boolean): { text: string; ok: boolean } {
  if (!isError) return { text: "exit 0", ok: true };
  const text = result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
  const code = text.match(/Command exited with code (-?\d+)\s*$/);
  if (code) return { text: `exit ${code[1]}`, ok: false };
  if (/Command aborted\s*$/.test(text)) return { text: "aborted", ok: false };
  if (/Command timed out after \d+ seconds\s*$/.test(text)) return { text: "timed out", ok: false };
  return { text: "failed", ok: false };
}

function collapsedResult(theme: Theme, label: { text: string; ok: boolean }): Component {
  return {
    render(width) {
      return [theme.fg(label.ok ? "success" : "error", truncatePlain(label.text, width))];
    },
    invalidate() {},
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerToolRenderer((toolName, next) => {
    const renderers = next();
    const renderFullCall = renderers?.renderCall;
    const renderFullResult = renderers?.renderResult;
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
      renderResult(result, options, theme, context) {
        if (!renderFullResult) return emptyResult;
        const fullResult = renderFullResult(result, options, theme, {
          ...context,
          lastComponent: context.state.fullResult,
        });
        context.state.fullResult = fullResult;
        if (context.expanded) return fullResult;
        if (options.isPartial) return emptyResult;
        return collapsedResult(theme, statusLabel(result, context.isError));
      },
    };
  });
}
