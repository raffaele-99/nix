/** Remove Pi's CWD section from model-facing system messages. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("context_with_system", (event) => {
		let changed = false;
		const messages = event.messages.map((message) => {
			if (message.role !== "system" || !message.sections || !("cwd" in message.sections)) {
				return message;
			}

			const sections = { ...message.sections };
			delete sections.cwd;
			changed = true;
			return { ...message, sections };
		});

		if (changed) return { messages };
	});
}
