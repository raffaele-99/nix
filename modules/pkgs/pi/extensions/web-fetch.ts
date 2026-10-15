import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL with curl and return the raw response body. Use this to read pages found with web_search; the read tool only opens local files.",
    parameters: Type.Object({ url: Type.String({ description: "http(s) URL to fetch" }) }),

    async execute(_toolCallId, { url }, signal) {
      try {
        const { stdout } = await execFileAsync(
          "curl",
          ["-sSfL", "--max-time", "30", "--proto", "=http,https", "--proto-redir", "=http,https", "--", url],
          { signal, encoding: "utf-8", maxBuffer: 25 * 1024 * 1024 },
        );
        const { content } = truncateHead(stdout, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        return { content: [{ type: "text", text: content }], details: {} };
      } catch (err: any) {
        if (signal?.aborted) throw new Error("aborted");
        return { content: [{ type: "text", text: `web_fetch failed: ${err?.stderr?.trim() || err?.message}` }], details: {} };
      }
    },

    renderResult(result, { expanded }, theme) {
      const content = result.content[0];
      const text = content?.type === "text" ? content.text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "") : "";
      if (text.startsWith("web_fetch failed")) return new Text(theme.fg("error", text), 0, 0);
      if (expanded) return new Text(theme.fg("dim", text), 0, 0);
      const tokens = Math.ceil(text.length / 4).toLocaleString();
      return new Text(theme.fg("success", `${formatSize(Buffer.byteLength(text))} (${tokens} tokens)`), 0, 0);
    },
  });
}
