/**
 * Context Message
 *
 * Adds the editor contents to the conversation without starting an LLM turn.
 *
 * Usage:
 *   pi -e ./context-message.ts
 *
 * The default shortcut is Ctrl+Enter. Override it with:
 *   pi -e ./context-message.ts --context-message-key ctrl+shift+enter
 *
 * If installed in ~/.pi/agent/extensions/, only --context-message-key is needed.
 */

import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, type KeyId, Markdown } from "@earendil-works/pi-tui";

const MESSAGE_TYPE = "context-message";
const DEFAULT_SHORTCUT: KeyId = "ctrl+enter";
const DARK_BACKGROUND = "\x1b[48;2;21;54;74m";
const DARK_BACKGROUND_256 = "\x1b[48;5;23m";
const LIGHT_BACKGROUND = "\x1b[48;2;217;238;247m";
const LIGHT_BACKGROUND_256 = "\x1b[48;5;195m";
const RESET_BACKGROUND = "\x1b[49m";

export default function (pi: ExtensionAPI) {
	pi.registerFlag("context-message-key", {
		description: "Shortcut for adding editor text to context without generating a response",
		type: "string",
		default: DEFAULT_SHORTCUT,
	});

	// Context-only input is a custom message because sendUserMessage() always
	// starts an LLM turn. Give it a dedicated background without a type label.
	pi.registerMessageRenderer(MESSAGE_TYPE, (message, { outputPad }, theme) => {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
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
		box.addChild(
			new Markdown(text, 0, 0, getMarkdownTheme(), {
				color: (content) => theme.fg("text", content),
			}),
		);
		return box;
	});

	// CLI extension flags are resolved before session_start. Registering the
	// shortcut here lets --context-message-key determine the binding.
	pi.on("session_start", () => {
		const configuredShortcut = pi.getFlag("context-message-key");
		const shortcut =
			typeof configuredShortcut === "string" && configuredShortcut.trim()
				? (configuredShortcut.trim() as KeyId)
				: DEFAULT_SHORTCUT;

		pi.registerShortcut(shortcut, {
			description: "Add editor text to context without generating a response",
			handler: (ctx) => {
				const text = ctx.ui.getEditorText().trim();
				if (!text) return;

				ctx.ui.setEditorText("");
				pi.sendMessage(
					{
						customType: MESSAGE_TYPE,
						content: text,
						display: true,
					},
					{ triggerTurn: false },
				);
			},
		});
	});
}
