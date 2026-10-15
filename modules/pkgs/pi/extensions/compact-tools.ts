import { homedir } from "node:os";
import { type ExtensionAPI, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

type ToolResult = { content: { type: string; text?: string }[]; details?: any };

type Compaction = {
  call?: (args: any, theme: Theme) => Component;
  summary?: (result: ToolResult, theme: Theme) => Component;
};

const emptyResult: Component = { render: () => [], invalidate() {} };

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function displayPath(args: any): string {
  const path = args?.file_path ?? args?.path;
  if (typeof path !== "string") return "";
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function expandHint(theme: Theme): string {
  return `${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

function compactCall(title: string, detail: (args: any) => string | undefined): Compaction["call"] {
  return (args, theme) => {
    const note = detail(args);
    const parts = [
      theme.fg("toolTitle", theme.bold(title)),
      theme.fg("accent", displayPath(args)),
      note ? theme.fg("muted", `(${note})`) : "",
      expandHint(theme),
    ];
    return new Text(parts.filter(Boolean).join(" "), 0, 0);
  };
}

function listingSummary(one: string, many?: string): Compaction["summary"] {
  return (result, theme) => {
    const text = result.content
      .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
      .join("\n")
      .trim();
    const lines = text ? text.split("\n").length : 0;
    const details = result.details ?? {};
    const truncated =
      details.truncation?.truncated || details.matchLimitReached || details.resultLimitReached || details.entryLimitReached;

    let label = count(lines, one, many);
    if (lines === 0) label = "no output";
    if (lines === 1 && /^no /i.test(text)) label = text;

    const parts = [theme.fg("muted", label), truncated ? theme.fg("warning", "[truncated]") : "", expandHint(theme)];
    return new Text(parts.filter(Boolean).join(" "), 0, 0);
  };
}

const compactions: Record<string, Compaction> = {
  write: {
    call: compactCall("write", (args) =>
      typeof args?.content === "string" ? count(args.content.split("\n").length, "line") : undefined,
    ),
  },
  edit: {
    call: compactCall("edit", (args) =>
      Array.isArray(args?.edits) && args.edits.length > 1 ? count(args.edits.length, "edit") : undefined,
    ),
  },
  grep: { summary: listingSummary("line") },
  find: { summary: listingSummary("result") },
  ls: { summary: listingSummary("entry", "entries") },
};

export default function (pi: ExtensionAPI) {
  pi.registerToolRenderer((toolName, next) => {
    const renderers = next();
    const compaction = compactions[toolName];
    if (!renderers?.renderCall || !renderers.renderResult || !compaction) return renderers;
    const { renderCall, renderResult } = renderers;

    return {
      ...renderers,
      renderCall(args, theme, context) {
        const fullCall = renderCall(args, theme, { ...context, lastComponent: context.state.fullCall });
        context.state.fullCall = fullCall;
        if (context.expanded || !compaction.call) return fullCall;
        return compaction.call(args, theme);
      },
      renderResult(result, options, theme, context) {
        const fullResult = renderResult(result, options, theme, { ...context, lastComponent: context.state.fullResult });
        context.state.fullResult = fullResult;
        if (context.expanded || context.isError) return fullResult;
        return compaction.summary?.(result, theme) ?? emptyResult;
      },
    };
  });
}
