import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const blockTags =
  /<\/?(?:title|p|div|br|hr|tr|ul|ol|dl|dt|dd|table|section|article|header|footer|nav|main|aside|blockquote|figure|figcaption|details|summary|h[1-6])\b[^>]*>/gi;
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] !== "#") return entities[name.toLowerCase()] ?? entity;
    const code = Number(name.slice(1).replace(/^x/i, "0x"));
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function htmlToMarkdown(html: string): string {
  const pres: string[] = [];
  const markdown = html
    .replace(/<!--[\s\S]*?-->|<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, code: string) => `\0${pres.push(code) - 1}\0`)
    .replace(/\s+/g, " ")
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<\/?code\b[^>]*>/gi, "`")
    .replace(blockTags, "\n")
    .replace(
      /<a\b[^>]*?\shref\s*=\s*["']?([^"'\s>]*)["']?[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_, href: string, text: string) => `[${text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()}](${href})`,
    )
    .replace(/<[^>]*>/g, "")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\0(\d+)\0/g, (_, i: string) => `\n\`\`\`\n${pres[Number(i)].replace(/<[^>]*>/g, "")}\n\`\`\`\n`);
  return decodeEntities(markdown).trim();
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL with curl. HTML is returned as markdown; when the output is converted or truncated, the raw response is saved to the file named at the end. Use this to read pages found with web_search; the read tool only opens local files.",
    parameters: Type.Object({ url: Type.String({ description: "http(s) URL to fetch" }) }),

    async execute(_toolCallId, { url }, signal) {
      try {
        const target = url.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\//, "https://raw.githubusercontent.com/$1/");
        const raw = join(await mkdtemp(join(tmpdir(), "pi-web-fetch-")), "raw");
        const { stdout: type } = await execFileAsync(
          "curl",
          [
            "-sSfL",
            "--globoff",
            "--max-time", "30",
            "--max-filesize", String(25 * 1024 * 1024),
            "--proto", "=http,https",
            "--proto-redir", "=http,https",
            "-o", raw,
            "-w", "%{content_type}",
            "--", target,
          ],
          { signal },
        );
        const body = await readFile(raw, "utf8");
        const html = /html/i.test(type);
        const { content, truncated } = truncateHead(html ? htmlToMarkdown(body) : body, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });
        if (!html && !truncated) return { content: [{ type: "text", text: content }], details: {} };
        const note = `\n\n[${truncated ? "Truncated. " : ""}Raw response: ${raw}]`;
        return { content: [{ type: "text", text: content + note }], details: { rawBytes: Buffer.byteLength(body) } };
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
      const rawBytes = (result.details as { rawBytes?: number } | undefined)?.rawBytes;
      const size = `${rawBytes ? `${formatSize(rawBytes)} → ` : ""}${formatSize(Buffer.byteLength(text))}`;
      const tokens = Math.ceil(text.length / 4).toLocaleString();
      return new Text(theme.fg("success", `${size} (${tokens} tokens)`), 0, 0);
    },
  });
}
