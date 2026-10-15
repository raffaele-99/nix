import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  type TruncationResult,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

const execFileAsync = promisify(execFile);

const sandboxBridge = process.env.PI_SANDBOX_SEARCH_PORT
  ? { port: Number(process.env.PI_SANDBOX_SEARCH_PORT), token: process.env.PI_SANDBOX_SEARCH_TOKEN ?? "" }
  : undefined;

const SearchParams = Type.Object({
  query: Type.String({ description: "The search query" }),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Number of results (default 20)" })),
  include_sites: Type.Optional(
    Type.Array(Type.String(), { description: "Only return results from these domains; exclusive with exclude_sites" }),
  ),
  exclude_sites: Type.Optional(
    Type.Array(Type.String(), { description: "Drop results from these domains; exclusive with include_sites" }),
  ),
  operators: Type.Optional(
    Type.Boolean({ description: "Interpret search operators in the query (site:, intitle:, filetype:, etc.)" }),
  ),
});

interface SearchDetails {
  query: string;
  resultCount?: number;
  truncation?: TruncationResult;
  fullOutputPath?: string;
  error?: string;
}

interface SearchResult {
  title: string;
  url: string;
  description?: string;
}

type SearchInput = Static<typeof SearchParams>;

function bxsArgs(params: SearchInput): string[] {
  const args = ["search"];
  if (params.count !== undefined) args.push(`--count=${params.count}`);
  for (const site of params.include_sites ?? []) args.push(`--include-site=${site}`);
  for (const site of params.exclude_sites ?? []) args.push(`--exclude-site=${site}`);
  if (params.operators !== undefined) args.push(`--operators=${params.operators}`);
  args.push("--", params.query);
  return args;
}

async function search(params: SearchInput, signal?: AbortSignal): Promise<string> {
  if (sandboxBridge) return searchOnHost(sandboxBridge, params, signal);
  const { stdout } = await execFileAsync("bxs", bxsArgs(params), {
    signal,
    encoding: "utf-8",
    maxBuffer: 100 * 1024 * 1024,
  });
  return stdout;
}

function searchOnHost(
  bridge: { port: number; token: string },
  params: SearchInput,
  signal?: AbortSignal,
): Promise<string> {
  const body = JSON.stringify(params);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "host.docker.internal",
        port: bridge.port,
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${bridge.token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 200) return resolve(data);
          reject(Object.assign(new Error(`search bridge returned HTTP ${res.statusCode}`), { stderr: data }));
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function countResults(output: string): number | undefined {
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed.length : undefined;
  } catch {
    return undefined;
  }
}

function describeFailure(err: any): string {
  if (err?.code === "ENOENT") return "bxs not found on PATH";
  const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
  return stderr || err?.message || "unknown error";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: `Search the web via Brave Search. Returns a JSON array of {title, url, description}. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(
      DEFAULT_MAX_BYTES,
    )} (whichever is hit first); if truncated, full output is saved to a temp file.`,
    promptSnippet: "Search the web with the web_search tool",
    parameters: SearchParams,

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      if (params.include_sites?.length && params.exclude_sites?.length) {
        const msg = "include_sites and exclude_sites cannot be used together";
        return {
          content: [{ type: "text", text: `web_search failed: ${msg}` }],
          details: { query: params.query, error: msg } as SearchDetails,
        };
      }

      let output: string;
      try {
        output = await search(params, signal);
      } catch (err: any) {
        if (err?.name === "AbortError" || signal?.aborted) {
          throw new Error("aborted");
        }
        const msg = describeFailure(err);
        return {
          content: [{ type: "text", text: `web_search failed: ${msg}` }],
          details: { query: params.query, error: msg } as SearchDetails,
        };
      }

      const resultCount = countResults(output);
      if (!output.trim() || resultCount === 0) {
        return {
          content: [{ type: "text", text: "No results found" }],
          details: { query: params.query, resultCount: 0 } as SearchDetails,
        };
      }

      const truncation = truncateHead(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      const details: SearchDetails = { query: params.query, resultCount };
      let resultText = truncation.content;

      if (truncation.truncated) {
        const tempDir = await mkdtemp(join(tmpdir(), "pi-web-search-"));
        const tempFile = join(tempDir, "output.json");
        await withFileMutationQueue(tempFile, async () => {
          await writeFile(tempFile, output, "utf8");
        });

        details.truncation = truncation;
        details.fullOutputPath = tempFile;

        const truncatedLines = truncation.totalLines - truncation.outputLines;
        const truncatedBytes = truncation.totalBytes - truncation.outputBytes;

        resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
        resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
        resultText += ` ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted.`;
        resultText += ` Full output saved to: ${tempFile}]`;
      }

      return {
        content: [{ type: "text", text: resultText }],
        details,
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", `"${args.query}"`);
      if (args.include_sites?.length) text += theme.fg("dim", ` only ${args.include_sites.join(", ")}`);
      if (args.exclude_sites?.length) text += theme.fg("dim", ` not ${args.exclude_sites.join(", ")}`);
      if (args.count !== undefined) text += theme.fg("dim", ` ×${args.count}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, _context) {
      const details = result.details as SearchDetails | undefined;

      if (isPartial) {
        return new Text(theme.fg("warning", "Searching..."), 0, 0);
      }

      if (details?.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      const summary =
        details?.resultCount === undefined ? "Search results" : `${details.resultCount} results`;
      let text = theme.fg("success", summary);
      if (details?.truncation?.truncated) {
        text += theme.fg("warning", " (truncated)");
      }

      if (!expanded) {
        return new Text(text, 0, 0);
      }

      const content = result.content[0];
      if (content?.type === "text") {
        let results: SearchResult[] | undefined;
        try {
          results = JSON.parse(content.text);
        } catch {}
        if (Array.isArray(results)) {
          for (const r of results) {
            text += `\n${theme.fg("accent", r.title)} ${theme.fg("dim", r.url)}`;
          }
        } else {
          for (const line of content.text.split("\n").slice(0, 40)) {
            text += `\n${theme.fg("dim", line)}`;
          }
        }
      }
      if (details?.fullOutputPath) {
        text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
      }

      return new Text(text, 0, 0);
    },
  });
}
