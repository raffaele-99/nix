/**
 * Context Message
 *
 * Adds the editor contents to the conversation with an explicit provider role
 * and response policy.
 *
 * Usage:
 *   pi -e ./context-message.ts
 *
 * Ctrl+Enter adds user context without starting an LLM turn. Ctrl+Opt+Enter
 * opens a composer for choosing the exact role and response policy. Override
 * them with:
 *   pi -e ./context-message.ts --context-message-key ctrl+shift+enter
 *   pi -e ./context-message.ts --context-message-composer-key alt+shift+enter
 *
 * If installed in ~/.pi/agent/extensions/, only the shortcut flags are needed.
 */

import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, type KeyId, Markdown, Text } from "@earendil-works/pi-tui";

const MESSAGE_TYPE = "context-message";
const DEFAULT_SHORTCUT: KeyId = "ctrl+enter";
const DEFAULT_COMPOSER_SHORTCUT: KeyId = "ctrl+alt+enter";
const ORDER_PRESERVING_PROVIDER = "openrouter";
const ORDER_PRESERVING_MODEL = "anthropic/claude-opus-5.5";
const ORDER_MARKER_PREFIX = "\u{e000}pi-context-message-order:";
const ORDER_MARKER_SUFFIX = "\u{e001}";
const ORDER_MARKER_PATTERN = /^\u{e000}pi-context-message-order:(\d+):(\d+)\u{e001}\n?/u;
const ROLE_MARKER_PREFIX = "\u{e002}pi-context-message-role:";
const ROLE_MARKER_SUFFIX = "\u{e003}";
const ROLE_MARKER_PATTERN = /^\u{e002}pi-context-message-role:(user|system|developer)\u{e003}\n?/u;
const DARK_BACKGROUND = "\x1b[48;2;21;54;74m";
const DARK_BACKGROUND_256 = "\x1b[48;5;23m";
const LIGHT_BACKGROUND = "\x1b[48;2;217;238;247m";
const LIGHT_BACKGROUND_256 = "\x1b[48;5;195m";
const RESET_BACKGROUND = "\x1b[49m";

type ProviderMessage = Record<string, unknown> & {
	role?: unknown;
	content?: unknown;
};

type MessageRole = "user" | "system" | "developer";

type ContextMessageDetails = {
	role: MessageRole;
	responseRequired: boolean;
};

type MarkedProviderMessage = {
	message: ProviderMessage;
	nonSystemMessagesBefore: number;
	sequence: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageRole(value: unknown): value is MessageRole {
	return value === "user" || value === "system" || value === "developer";
}

function getMessageDetails(value: unknown): ContextMessageDetails {
	if (!isRecord(value)) return { role: "user", responseRequired: false };
	return {
		role: isMessageRole(value.role) ? value.role : "user",
		responseRequired: value.responseRequired === true,
	};
}

function getMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) =>
			isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
		)
		.join("\n");
}

function roleMarker(role: MessageRole): string {
	return `${ROLE_MARKER_PREFIX}${role}${ROLE_MARKER_SUFFIX}\n`;
}

function preservesSystemContextOrder(model: unknown): boolean {
	if (!isRecord(model)) return false;
	const compat = isRecord(model.compat) ? model.compat : undefined;
	return (
		model.provider === ORDER_PRESERVING_PROVIDER &&
		model.id === ORDER_PRESERVING_MODEL &&
		model.api === "anthropic-messages" &&
		compat?.supportsMidConvoSystemMessages === true
	);
}

function stripOrderMarker(message: ProviderMessage): MarkedProviderMessage | undefined {
	if (message.role !== "system") return;

	if (typeof message.content === "string") {
		const match = message.content.match(ORDER_MARKER_PATTERN);
		if (!match) return;
		return {
			message: { ...message, content: message.content.replace(ORDER_MARKER_PATTERN, "") },
			nonSystemMessagesBefore: Number(match[1]),
			sequence: Number(match[2]),
		};
	}

	if (!Array.isArray(message.content)) return;
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index];
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		const match = block.text.match(ORDER_MARKER_PATTERN);
		if (!match) continue;

		const content = [...message.content];
		content[index] = { ...block, text: block.text.replace(ORDER_MARKER_PATTERN, "") };
		return {
			message: { ...message, content },
			nonSystemMessagesBefore: Number(match[1]),
			sequence: Number(match[2]),
		};
	}
}

function restoreMarkedSystemOrder(segment: unknown[]): unknown[] {
	const marked: MarkedProviderMessage[] = [];
	const unmarked: unknown[] = [];

	for (const value of segment) {
		if (!isRecord(value)) {
			unmarked.push(value);
			continue;
		}
		const parsed = stripOrderMarker(value);
		if (parsed) marked.push(parsed);
		else unmarked.push(value);
	}

	if (marked.length === 0) return segment;

	marked.sort(
		(left, right) =>
			left.nonSystemMessagesBefore - right.nonSystemMessagesBefore || left.sequence - right.sequence,
	);

	const restored: unknown[] = [];
	let markedIndex = 0;
	let nonSystemMessagesSeen = 0;
	for (const value of unmarked) {
		while (
			markedIndex < marked.length &&
			marked[markedIndex].nonSystemMessagesBefore <= nonSystemMessagesSeen
		) {
			restored.push(marked[markedIndex].message);
			markedIndex++;
		}

		restored.push(value);
		if (!isRecord(value) || value.role !== "system") nonSystemMessagesSeen++;
	}

	while (markedIndex < marked.length) {
		restored.push(marked[markedIndex].message);
		markedIndex++;
	}
	return restored;
}

function restoreProviderSystemOrder(payload: unknown): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;

	const messages: unknown[] = [];
	let segment: unknown[] = [];
	for (const message of payload.messages) {
		if (isRecord(message) && message.role === "assistant") {
			messages.push(...restoreMarkedSystemOrder(segment), message);
			segment = [];
		} else {
			segment.push(message);
		}
	}
	messages.push(...restoreMarkedSystemOrder(segment));
	return { ...payload, messages };
}

function restoreHoistedSystemMessages(payload: unknown): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;

	const system = payload.system;
	const hoisted: ProviderMessage[] = [];
	let remainingSystem: unknown;

	if (typeof system === "string") {
		if (!ORDER_MARKER_PATTERN.test(system)) return payload;
		hoisted.push({ role: "system", content: system });
	} else if (Array.isArray(system)) {
		const remaining: unknown[] = [];
		for (const block of system) {
			if (
				isRecord(block) &&
				block.type === "text" &&
				typeof block.text === "string" &&
				ORDER_MARKER_PATTERN.test(block.text)
			) {
				hoisted.push({ role: "system", content: [block] });
			} else {
				remaining.push(block);
			}
		}
		if (hoisted.length === 0) return payload;
		if (remaining.length > 0) remainingSystem = remaining;
	} else {
		return payload;
	}

	const restored: Record<string, unknown> = {
		...payload,
		messages: [...hoisted, ...payload.messages],
	};
	if (remainingSystem === undefined) delete restored.system;
	else restored.system = remainingSystem;
	return restored;
}

function rewriteMarkedProviderRole(message: unknown): unknown {
	if (!isRecord(message)) return message;

	if (typeof message.content === "string") {
		const match = message.content.match(ROLE_MARKER_PATTERN);
		if (!match || !isMessageRole(match[1])) return message;
		return {
			...message,
			role: match[1],
			content: message.content.replace(ROLE_MARKER_PATTERN, ""),
		};
	}

	if (!Array.isArray(message.content)) return message;
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index];
		if (!isRecord(block) || typeof block.text !== "string") continue;
		const match = block.text.match(ROLE_MARKER_PATTERN);
		if (!match || !isMessageRole(match[1])) continue;

		const content = [...message.content];
		content[index] = { ...block, text: block.text.replace(ROLE_MARKER_PATTERN, "") };
		return { ...message, role: match[1], content };
	}

	return message;
}

function rewriteMarkedProviderRoles(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;

	let changed = false;
	const rewritten: Record<string, unknown> = { ...payload };
	for (const key of ["messages", "input"] as const) {
		const entries = payload[key];
		if (!Array.isArray(entries)) continue;
		const nextEntries = entries.map((entry) => {
			const next = rewriteMarkedProviderRole(entry);
			if (next !== entry) changed = true;
			return next;
		});
		rewritten[key] = nextEntries;
	}

	return changed ? rewritten : payload;
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("context-message-key", {
		description: "Shortcut for adding editor text as user context without generating a response",
		type: "string",
		default: DEFAULT_SHORTCUT,
	});
	pi.registerFlag("context-message-composer-key", {
		description: "Shortcut for choosing a message role and response policy",
		type: "string",
		default: DEFAULT_COMPOSER_SHORTCUT,
	});
	pi.registerFlag("system-context-message-key", {
		description: "Deprecated alias for --context-message-composer-key",
		type: "string",
	});

	// Controlled input is a custom message so its role and response policy remain
	// durable session metadata instead of being implicit in the shortcut used.
	pi.registerMessageRenderer(MESSAGE_TYPE, (message, { outputPad }, theme) => {
		const text = getMessageText(message.content);
		const details = getMessageDetails(message.details);
		const isLightTheme = theme.name?.toLowerCase().includes("light") ?? false;
		const background =
			theme.getColorMode() === "truecolor"
				? isLightTheme
					? LIGHT_BACKGROUND
					: DARK_BACKGROUND
				: isLightTheme
					? LIGHT_BACKGROUND_256
					: DARK_BACKGROUND_256;
		const box = new Box(outputPad, 1, (content) => `${background}${content}${RESET_BACKGROUND}`);
		const roleLabel =
			details.role === "system"
				? theme.fg("warning", "system")
				: details.role === "developer"
					? theme.fg("accent", "developer")
					: theme.fg("success", "user");
		const responseLabel = details.responseRequired ? "response required" : "context only";
		box.addChild(new Text(`${theme.bold(roleLabel)} ${theme.fg("dim", `· ${responseLabel}`)}`, 0, 0));
		box.addChild(
			new Markdown(text, 0, 0, getMarkdownTheme(), {
				color: (content) => theme.fg("text", content),
			}),
		);
		return box;
	});

	// Custom messages normally become user messages. Convert controlled messages
	// to the closest Pi transcript role and tag them so the final provider hook
	// can enforce the exact requested wire role after adapter normalization.
	pi.on("context_with_system", (event, ctx) => {
		let changed = false;
		let nonSystemMessagesInSegment = 0;
		let systemMessageSequence = 0;
		const preserveOrder = preservesSystemContextOrder(ctx.model);
		const messages = event.messages.map((message) => {
			if (message.role === "assistant") {
				nonSystemMessagesInSegment = 0;
				return message;
			}

			if (message.role !== "custom" || message.customType !== MESSAGE_TYPE) {
				if (message.role !== "system" && !(message.role === "bashExecution" && message.excludeFromContext)) {
					nonSystemMessagesInSegment++;
				}
				return message;
			}

			changed = true;
			const details = getMessageDetails(message.details);
			const content = getMessageText(message.content);
			if (details.role === "user") {
				nonSystemMessagesInSegment++;
				return {
					role: "user" as const,
					content: [{ type: "text" as const, text: content }],
					timestamp: message.timestamp,
				};
			}

			const orderMarker = preserveOrder
				? `${ORDER_MARKER_PREFIX}${nonSystemMessagesInSegment}:${systemMessageSequence++}${ORDER_MARKER_SUFFIX}\n`
				: "";
			return {
				role: "system" as const,
				content: `${orderMarker}${roleMarker(details.role)}${content}`,
				timestamp: message.timestamp,
			};
		});

		if (changed) return { messages };
	});

	// Pi's Anthropic serializer delays system messages until the next assistant
	// boundary and hoists the leading one into the top-level system prompt.
	// Restore verified Claude ordering first, then strip the private markers and
	// enforce each controlled message's exact provider role.
	pi.on("before_provider_request", (event, ctx) => {
		const preserveOrder = preservesSystemContextOrder(ctx.model);
		const unhoistedPayload = preserveOrder
			? restoreHoistedSystemMessages(event.payload)
			: event.payload;
		const orderedPayload = preserveOrder
			? restoreProviderSystemOrder(unhoistedPayload)
			: unhoistedPayload;
		return rewriteMarkedProviderRoles(orderedPayload);
	});

	// CLI extension flags are resolved before session_start. Registering the
	// shortcuts here lets their flags determine the bindings.
	pi.on("session_start", (_event, ctx) => {
		const configuredContextShortcut = pi.getFlag("context-message-key");
		const contextShortcut =
			typeof configuredContextShortcut === "string" && configuredContextShortcut.trim()
				? (configuredContextShortcut.trim() as KeyId)
				: DEFAULT_SHORTCUT;
		const configuredLegacyComposerShortcut = pi.getFlag("system-context-message-key");
		const configuredComposerShortcut =
			typeof configuredLegacyComposerShortcut === "string" && configuredLegacyComposerShortcut.trim()
				? configuredLegacyComposerShortcut
				: pi.getFlag("context-message-composer-key");
		const composerShortcut =
			typeof configuredComposerShortcut === "string" && configuredComposerShortcut.trim()
				? (configuredComposerShortcut.trim() as KeyId)
				: DEFAULT_COMPOSER_SHORTCUT;

		const sendControlledMessage = (role: MessageRole, responseRequired: boolean, text: string) => {
			ctx.ui.setEditorText("");
			pi.sendMessage<ContextMessageDetails>(
				{
					customType: MESSAGE_TYPE,
					content: text,
					display: true,
					details: { role, responseRequired },
				},
				{ triggerTurn: responseRequired },
			);
		};

		pi.registerShortcut(composerShortcut, {
			description: "Choose the exact role and whether this message requires a response",
			handler: async () => {
				const text = ctx.ui.getEditorText().trim();
				if (!text) return;

				const roleChoice = await ctx.ui.select("Send message with role", [
					"user — end-user input",
					"system — exact system role",
					"developer — exact developer role",
				]);
				if (!roleChoice) return;
				const role = roleChoice.split(" ", 1)[0];
				if (!isMessageRole(role)) return;

				const responseChoice = await ctx.ui.select("Require a model response?", [
					"no — add to context only",
					"yes — start a model turn",
				]);
				if (!responseChoice) return;
				sendControlledMessage(role, responseChoice.startsWith("yes"), text);
			},
		});

		pi.registerShortcut(contextShortcut, {
			description: "Add editor text as user context without generating a response",
			handler: () => {
				const text = ctx.ui.getEditorText().trim();
				if (!text) return;
				sendControlledMessage("user", false, text);
			},
		});
	});
}
