// Pi resolves and refreshes credentials; no toadex auth command or Codex files.
export interface ModelCredential {
	apiKey?: string;
	accessToken?: string;
	accountId?: string;
}

export function openAICredential(provider: string, apiKey?: string): ModelCredential {
	if (!apiKey) throw new Error(`No credential for ${provider}; use /login or configure an API key in pi2.`);
	if (provider === "openai") return { apiKey };
	const payload = apiKey.split(".")[1];
	let accountId: unknown;
	try {
		accountId = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))["https://api.openai.com/auth"]?.chatgpt_account_id;
	} catch {
		throw new Error("Invalid Codex access token; use /login openai-codex in pi2.");
	}
	if (typeof accountId !== "string" || !accountId) throw new Error("Codex access token has no ChatGPT account ID.");
	return { accessToken: apiKey, accountId };
}
