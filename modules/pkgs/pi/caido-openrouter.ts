/**
 * Keep OpenRouter's Claude Opus 5.5 streams alive through Caido.
 *
 * Caido 0.58.x stops buffering an HTTP/1 response after roughly five seconds
 * without body bytes. OpenRouter's Anthropic Messages endpoint can be silent
 * while it signs a thinking block, whereas its Chat Completions endpoint emits
 * SSE comment heartbeats. Use that transport for this model whenever
 * pi-sandbox is launched with --caido-url.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openrouter";
const MODEL = "anthropic/claude-opus-5.5";
const CHAT_API = "openai-completions";
const CHAT_BASE_URL = "https://openrouter.ai/api/v1";

type PiModel = NonNullable<ExtensionContext["model"]>;

function withHeartbeatTransport(model: ExtensionContext["model"]): PiModel | undefined {
	if (!model || model.provider !== PROVIDER || model.id !== MODEL || model.api === CHAT_API) return;

	return {
		...model,
		api: CHAT_API,
		baseUrl: CHAT_BASE_URL,
		compat: {
			...model.compat,
			cacheControlFormat: "anthropic",
			sendSessionAffinityHeaders: true,
			sessionAffinityFormat: "openrouter",
			supportsDeveloperRole: false,
			supportsMidConvoSystemMessages: true,
			supportsStrictMode: true,
			thinkingFormat: "openrouter",
		},
	} as PiModel;
}

export default function (pi: ExtensionAPI) {
	const switchTransport = async (model: ExtensionContext["model"]) => {
		const replacement = withHeartbeatTransport(model);
		if (replacement) await pi.setModel(replacement);
	};

	pi.on("session_start", async (_event, ctx) => {
		await switchTransport(ctx.model);
	});

	pi.on("model_select", async (event) => {
		await switchTransport(event.model);
	});
}
