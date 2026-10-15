import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

function stripKnownExtension(name: string): string {
  return name.replace(/\.(html?|jsonl|json)$/i, "");
}

/// The sessions directory is shared with the host, so exports written here survive the sandbox.
const SESSIONS_DIR = resolve(homedir(), ".pi/agent/sessions");

function resolveBase(arg: string): string {
  const trimmed = arg.trim();
  const base = stripKnownExtension(trimmed) || "session";
  return isAbsolute(base) ? base : resolve(SESSIONS_DIR, base);
}

/// Append -2, -3, ... until neither the .html nor the .jsonl export would clobber a file.
function findFreeBase(base: string): string {
  const isFree = (candidate: string) =>
    !existsSync(`${candidate}.jsonl`) && !existsSync(`${candidate}.html`);

  if (isFree(base)) {
    return base;
  }

  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (isFree(candidate)) {
      return candidate;
    }
  }
}

function writeJsonl(ctx: ExtensionCommandContext, filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const sm = ctx.sessionManager;
  const existing = sm.getHeader();
  const header = {
    type: "session",
    version: existing?.version ?? CURRENT_SESSION_VERSION,
    id: sm.getSessionId(),
    timestamp: new Date().toISOString(),
    cwd: sm.getCwd(),
  };

  const lines = [JSON.stringify(header)];
  let prevId: string | null = null;
  for (const entry of sm.getBranch()) {
    lines.push(JSON.stringify({ ...entry, parentId: prevId }));
    prevId = entry.id;
  }

  writeFileSync(filePath, `${lines.join("\n")}\n`);
}

function writeHtmlFromJsonl(jsonlPath: string, htmlPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [process.argv[1], "--export", jsonlPath, htmlPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(stderr.trim() || `pi --export exited with code ${code}`));
      }
    });
  });
}

export default function(pi: ExtensionAPI) {
  pi.registerCommand("save", {
    description: "Export session to both <name>.html and <name>.jsonl",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const base = findFreeBase(resolveBase(args));
      const jsonlPath = `${base}.jsonl`;
      const htmlPath = `${base}.html`;

      try {
        writeJsonl(ctx, jsonlPath);
        await writeHtmlFromJsonl(jsonlPath, htmlPath);
        ctx.ui.notify(`Session saved to: ${htmlPath} and ${jsonlPath}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        ctx.ui.notify(`Failed to save session: ${message}`, "error");
      }
    },
  });
}
