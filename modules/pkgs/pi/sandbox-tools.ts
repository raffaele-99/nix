/**
 * pi --sandbox: the agent's tools run in the sandbox container.
 *
 * pi, its settings and auth.json stay on the host. The built-in tools (read,
 * write, edit, bash, grep, find, ls) and `!` commands run in the container via
 * `docker exec`, where the workspace is the only host directory, at
 * /workspace. pi-sandbox starts pi with --no-builtin-tools, so if this
 * extension does not load the agent has no file or shell tools at all.
 *
 * The workspace's AGENTS.md or CLAUDE.md is read through the container too
 * (pi-sandbox passes --no-context-files): a symlink the agent leaves there
 * resolves inside the container, never to a host file.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type ExtensionAPI,
	type FindOperations,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const WORKSPACE = "/workspace";
// pi's lookup order: the first regular file wins.
const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const SESSION_VARIABLES = ["PI_SESSION_ID", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"];
const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};
const DEFAULT_GREP_LIMIT = 100;

type Result = { code: number; stdout: Buffer; stderr: Buffer };
type ExecOptions = {
	input?: string | Buffer;
	cwd?: string;
	env?: Record<string, string>;
	onData?: (data: Buffer) => void;
	signal?: AbortSignal;
};

export default function (pi: ExtensionAPI) {
	const container = process.env.PI_SANDBOX_CONTAINER;
	if (!container) throw new Error("sandbox-tools.ts runs only under pi --sandbox (PI_SANDBOX_CONTAINER is unset)");
	const hostCwd = process.cwd();

	// Every path is a container path. A host path inside the workspace (the user
	// may paste one) maps to /workspace; no other host path is reachable.
	const guest = (value: string): string => {
		const relative = path.relative(hostCwd, value);
		const inside = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
		if (path.isAbsolute(value) && inside) return path.posix.join(WORKSPACE, relative.split(path.sep).join("/"));
		return path.posix.resolve(WORKSPACE, value);
	};

	// Arguments go to docker as argv; no host path or host environment is involved.
	const exec = (args: string[], options: ExecOptions = {}): Promise<Result> =>
		new Promise((resolve, reject) => {
			const flags = [
				...(options.input === undefined ? [] : ["-i"]),
				...(options.cwd ? ["-w", options.cwd] : []),
				...Object.entries(options.env ?? {}).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
			];
			const child = spawn("docker", ["exec", ...flags, container, ...args], { stdio: ["pipe", "pipe", "pipe"] });
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			const onAbort = () => child.kill();
			options.signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout.on("data", (data: Buffer) => {
				stdout.push(data);
				options.onData?.(data);
			});
			child.stderr.on("data", (data: Buffer) => {
				stderr.push(data);
				options.onData?.(data);
			});
			child.on("error", reject);
			child.on("close", (code) => {
				options.signal?.removeEventListener("abort", onAbort);
				resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
			});
			child.stdin.end(options.input);
		});

	const failure = (result: Result, action: string) =>
		new Error(result.stderr.toString().trim() || `${action} failed in the sandbox`);
	const missing = (value: string) => new Error(`ENOENT: no such file or directory, access '${value}'`);

	const readOps: ReadOperations = {
		readFile: async (value) => {
			const result = await exec(["cat", "--", guest(value)]);
			if (result.code) throw failure(result, `reading ${value}`);
			return result.stdout;
		},
		access: async (value) => {
			if ((await exec(["test", "-r", guest(value)])).code) throw missing(value);
		},
		detectImageMimeType: async (value) => IMAGE_TYPES[path.posix.extname(value).toLowerCase()] ?? null,
	};

	const writeOps: WriteOperations = {
		writeFile: async (value, content) => {
			const result = await exec(["sh", "-c", 'cat > "$1"', "sh", guest(value)], { input: content });
			if (result.code) throw failure(result, `writing ${value}`);
		},
		mkdir: async (value) => {
			const result = await exec(["mkdir", "-p", "--", guest(value)]);
			if (result.code) throw failure(result, `creating ${value}`);
		},
	};

	const editOps: EditOperations = {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: async (value) => {
			if ((await exec(["sh", "-c", 'test -r "$1" && test -w "$1"', "sh", guest(value)])).code) throw missing(value);
		},
	};

	// Abort and timeout kill the command's processes in the container: each run
	// carries a marker in its environment, which its child processes inherit.
	const stopRun = (id: string) =>
		exec([
			"sh",
			"-c",
			'for f in /proc/[0-9]*/environ; do grep -qxzF "PI_SANDBOX_RUN=$1" "$f" 2>/dev/null && p=${f%/environ} && kill -KILL "${p#/proc/}" 2>/dev/null; done; true',
			"sh",
			id,
		]);

	const bashOps: BashOperations = {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			if (signal?.aborted) throw new Error("aborted");
			const id = randomUUID();
			const variables: Record<string, string> = { PI_SANDBOX_RUN: id };
			for (const name of SESSION_VARIABLES) {
				const value = env?.[name];
				if (value) variables[name] = value;
			}
			const local = new AbortController();
			let stopped: string | undefined;
			const stop = (reason: string) => {
				if (stopped) return;
				stopped = reason;
				void stopRun(id).finally(() => local.abort());
			};
			const onAbort = () => stop("aborted");
			signal?.addEventListener("abort", onAbort, { once: true });
			const timer = timeout && timeout > 0 ? setTimeout(() => stop(`timeout:${timeout}`), timeout * 1000) : undefined;
			try {
				const result = await exec(["bash", "-c", command], {
					cwd: guest(cwd),
					env: variables,
					onData,
					signal: local.signal,
				});
				if (stopped) throw new Error(stopped);
				return { exitCode: result.code };
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};

	// ls stats every entry; readdir records their types so that costs no extra exec.
	const lsOps = (): LsOperations => {
		const directories = new Map<string, boolean>();
		return {
			exists: async (value) => (await exec(["test", "-e", guest(value)])).code === 0,
			stat: async (value) => {
				const target = guest(value);
				let isDirectory = directories.get(target);
				if (isDirectory === undefined) {
					const result = await exec(["stat", "-L", "-c", "%F", "--", target]);
					if (result.code) throw failure(result, `stat ${value}`);
					isDirectory = result.stdout.toString().trim() === "directory";
				}
				const answer = isDirectory;
				return { isDirectory: () => answer };
			},
			readdir: async (value) => {
				const target = guest(value);
				const result = await exec(["find", target, "-mindepth", "1", "-maxdepth", "1", "-printf", "%Y %f\\0"]);
				if (result.code) throw failure(result, `listing ${value}`);
				return result.stdout
					.toString()
					.split("\0")
					.filter(Boolean)
					.map((entry) => {
						const name = entry.slice(2);
						directories.set(path.posix.join(target, name), entry[0] === "d");
						return name;
					});
			},
		};
	};

	// Patterns without a slash match file names; others match paths at any depth.
	const matchesGlob = (relative: string, pattern: string) =>
		pattern.includes("/")
			? path.posix.matchesGlob(relative, pattern) || path.posix.matchesGlob(relative, `**/${pattern}`)
			: path.posix.matchesGlob(path.posix.basename(relative), pattern);

	const findOps: FindOperations = {
		exists: async (value) => (await exec(["test", "-e", guest(value)])).code === 0,
		glob: async (pattern, cwd, { limit }) => {
			const root = guest(cwd);
			const result = await exec([
				"find",
				root,
				"(",
				"-name",
				".git",
				"-o",
				"-name",
				"node_modules",
				")",
				"-prune",
				"-o",
				"-type",
				"f",
				"-printf",
				"%P\\0",
			]);
			if (result.code && result.stdout.length === 0) throw failure(result, `searching ${cwd}`);
			const matches: string[] = [];
			for (const relative of result.stdout.toString().split("\0")) {
				if (matches.length >= limit) break;
				if (relative && matchesGlob(relative, pattern)) matches.push(path.posix.join(root, relative));
			}
			return matches;
		},
	};

	// pi's grep always runs ripgrep on the host, so it is replaced: ripgrep runs in the container.
	const grep = async (params: GrepToolInput, signal?: AbortSignal) => {
		const target = guest(params.path ?? ".");
		const isDirectory = (await exec(["test", "-d", target])).code === 0;
		const limit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
		const args = ["rg", "--json", "--max-count", String(limit)];
		if (params.ignoreCase) args.push("--ignore-case");
		if (params.literal) args.push("--fixed-strings");
		if (params.glob) args.push("--glob", params.glob);
		if (params.context && params.context > 0) args.push("--context", String(params.context));
		args.push("--regexp", params.pattern, "--", isDirectory ? "." : path.posix.basename(target));
		const result = await exec(args, { cwd: isDirectory ? target : path.posix.dirname(target), signal });
		if (signal?.aborted) throw new Error("Operation aborted");

		const text = (value: { text?: string; bytes?: string }) => value.text ?? Buffer.from(value.bytes ?? "", "base64").toString();
		const outputLines: string[] = [];
		let matchCount = 0;
		let linesTruncated = false;
		for (const line of result.stdout.toString().split("\n")) {
			if (!line || matchCount >= limit) continue;
			const event = JSON.parse(line);
			if (event.type !== "match" && event.type !== "context") continue;
			const file = text(event.data.path).replace(/^\.\//, "");
			const { text: content, wasTruncated } = truncateLine(text(event.data.lines).replace(/\r?\n$/, "").replace(/\r/g, ""));
			if (wasTruncated) linesTruncated = true;
			const separator = event.type === "match" ? ":" : "-";
			outputLines.push(`${file}${separator}${event.data.line_number}${separator} ${content}`);
			if (event.type === "match") matchCount++;
		}
		if (matchCount === 0) {
			if (result.code > 1) throw failure(result, "grep");
			return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
		}

		const details: GrepToolDetails = {};
		const notices: string[] = [];
		const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
		if (matchCount >= limit) {
			details.matchLimitReached = limit;
			notices.push(`${limit} matches limit reached`);
		}
		if (linesTruncated) {
			details.linesTruncated = true;
			notices.push("long lines truncated");
		}
		if (truncation.truncated) {
			details.truncation = truncation;
			notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		}
		const output = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
		return {
			content: [{ type: "text" as const, text: output }],
			details: Object.keys(details).length > 0 ? details : undefined,
		};
	};

	// File tools resolve paths against /workspace: execute without the session context, whose cwd is the host's.
	const read = createReadToolDefinition(WORKSPACE, { operations: readOps });
	const write = createWriteToolDefinition(WORKSPACE, { operations: writeOps });
	const edit = createEditToolDefinition(WORKSPACE, { operations: editOps });
	const find = createFindToolDefinition(WORKSPACE, { operations: findOps });
	pi.registerTool({ ...read, execute: (id, params, signal, onUpdate) => read.execute(id, params, signal, onUpdate) });
	pi.registerTool({ ...write, execute: (id, params, signal, onUpdate) => write.execute(id, params, signal, onUpdate) });
	pi.registerTool({ ...edit, execute: (id, params, signal, onUpdate) => edit.execute(id, params, signal, onUpdate) });
	pi.registerTool({
		...createBashToolDefinition(WORKSPACE),
		execute: (id, params, signal, onUpdate, ctx) =>
			createBashToolDefinition(WORKSPACE, {
				operations: bashOps,
				commandPrefix: pi.getSettings().shellCommandPrefix,
			}).execute(id, params, signal, onUpdate, ctx),
	});

	// Not active unless enabled, as in pi; replaced so that enabling them never reaches the host.
	pi.registerTool({
		...createGrepToolDefinition(WORKSPACE),
		defaultActive: false,
		execute: (_id, params, signal) => grep(params, signal),
	});
	pi.registerTool({
		...find,
		defaultActive: false,
		execute: (id, params, signal, onUpdate) => find.execute(id, params, signal, onUpdate),
	});
	pi.registerTool({
		...createLsToolDefinition(WORKSPACE),
		defaultActive: false,
		execute: (id, params, signal, onUpdate) =>
			createLsToolDefinition(WORKSPACE, { operations: lsOps() }).execute(id, params, signal, onUpdate),
	});
	pi.registerTool({
		...createPowerShellToolDefinition(WORKSPACE),
		defaultActive: false,
		execute: async () => {
			throw new Error("powershell is not available in the sandbox; use bash");
		},
	});

	pi.on("user_bash", () => ({ operations: bashOps }));

	let workspaceContext: Array<{ path: string; content: string }> = [];
	pi.on("session_start", async () => {
		const result = await exec([
			"sh",
			"-c",
			'for f in "$@"; do if [ -f "/workspace/$f" ]; then printf "%s\\0" "$f"; exec cat -- "/workspace/$f"; fi; done; exit 1',
			"sh",
			...CONTEXT_FILES,
		]);
		const output = result.stdout.toString();
		const end = output.indexOf("\0");
		workspaceContext =
			result.code === 0 && end > 0
				? [{ path: path.posix.join(WORKSPACE, output.slice(0, end)), content: output.slice(end + 1).replace(/^\uFEFF/, "") }]
				: [];
	});

	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		options.cwd = WORKSPACE;
		options.contextFiles = [
			...options.contextFiles.filter((file) => !guest(file.path).startsWith(`${WORKSPACE}/`)),
			...workspaceContext,
		];
	});
}
