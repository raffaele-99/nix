import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_JWT_CLAIM = "https://api.openai.com/auth";
const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const USD_TO_AUD = 1.44;
const AUTH_PATH = join(getAgentDir(), "auth.json");
const USAGE_POLL_MS = 120_000;
const USAGE_MIN_REFRESH_MS = 20_000;
const USAGE_FETCH_TIMEOUT_MS = 8000;

const USAGE_CACHE_FRESH_MS = 90_000;
const USAGE_BACKOFF_BASE_MS = 60_000;
const USAGE_BACKOFF_MAX_MS = 15 * 60_000;

type UsageSource = "anthropic" | "openai" | "openrouter" | "xai";
const USAGE_SOURCES: UsageSource[] = ["anthropic", "openai", "openrouter", "xai"];

interface UsageWindow {
  percent: number;
  resetsAt?: number;
}

interface UsageSnapshot {
  primary?: UsageWindow;
  secondary?: UsageWindow;
  credits?: { totalCredits: number; totalUsage: number };
}

interface UsageCache {
  data: UsageSnapshot;
  fetchedAt: number;
}

function usageCachePath(source: UsageSource): string {
  return join(getAgentDir(), "sessions", `usage-cache-${source}.json`);
}

function loadUsageCache(source: UsageSource): UsageCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(usageCachePath(source), "utf8"));
    if (parsed && typeof parsed.fetchedAt === "number" && parsed.data) {
      return parsed as UsageCache;
    }
  } catch {}
  return undefined;
}

function saveUsageCache(source: UsageSource, data: UsageSnapshot): void {
  try {
    const payload: UsageCache = { data, fetchedAt: Date.now() };
    writeFileSync(usageCachePath(source), JSON.stringify(payload));
  } catch {}
}

type UsageFetch =
  | { kind: "ok"; data: UsageSnapshot }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "skip" };

interface OAuthCred {
  access: string;
  accountId?: string;
}

function readOAuth(providerId: string): OAuthCred | undefined {
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
    const creds = auth?.[providerId];
    if (!creds || creds.type !== "oauth" || typeof creds.access !== "string") return undefined;
    if (typeof creds.expires === "number" && creds.expires <= Date.now()) return undefined;
    return { access: creds.access, accountId: typeof creds.accountId === "string" ? creds.accountId : undefined };
  } catch {
    return undefined;
  }
}

function readApiKey(providerId: string, envVar: string): string | undefined {
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
    const creds = auth?.[providerId];
    if (creds?.type === "api_key" && typeof creds.key === "string" && creds.key.length > 0) {
      return creds.key;
    }
  } catch {}
  const fromEnv = process.env[envVar];
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

function jwtAccountId(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    const id = payload?.[OPENAI_JWT_CLAIM]?.chatgpt_account_id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

async function getJson(url: string, headers: Record<string, string>): Promise<{ kind: "ok"; body: any } | Exclude<UsageFetch, { kind: "ok" }>> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    if (res.status === 429) {
      const retryAfterSeconds = Number(res.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0;
      return { kind: "rate_limited", retryAfterMs };
    }
    return { kind: "skip" };
  }
  return { kind: "ok", body: await res.json() };
}

function anthropicWindow(w: any): UsageWindow | undefined {
  if (!w || typeof w.utilization !== "number") return undefined;
  const resetsAt = w.resets_at ? new Date(w.resets_at).getTime() : NaN;
  return { percent: w.utilization, resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined };
}

function openaiWindow(w: any): UsageWindow | undefined {
  if (!w || typeof w.used_percent !== "number") return undefined;
  const resetsAt = typeof w.reset_at === "number" && w.reset_at > 0 ? w.reset_at * 1000 : undefined;
  return { percent: w.used_percent, resetsAt };
}

async function fetchAnthropicUsage(): Promise<UsageFetch> {
  const cred = readOAuth("anthropic");
  if (!cred) return { kind: "skip" };
  const res = await getJson(ANTHROPIC_USAGE_URL, {
    Authorization: `Bearer ${cred.access}`,
    "anthropic-beta": "oauth-2025-04-20",
    "Content-Type": "application/json",
  });
  if (res.kind !== "ok") return res;
  return {
    kind: "ok",
    data: { primary: anthropicWindow(res.body?.five_hour), secondary: anthropicWindow(res.body?.seven_day) },
  };
}

async function fetchOpenAIUsage(): Promise<UsageFetch> {
  for (const providerId of ["openai-codex", "openai"]) {
    const cred = readOAuth(providerId);
    const accountId = cred && (cred.accountId ?? jwtAccountId(cred.access));
    if (!cred || !accountId) continue;
    const res = await getJson(OPENAI_USAGE_URL, {
      Authorization: `Bearer ${cred.access}`,
      "ChatGPT-Account-Id": accountId,
      "User-Agent": "codex-cli",
    });
    if (res.kind === "skip") continue;
    if (res.kind !== "ok") return res;
    const rl = res.body?.rate_limit;
    return { kind: "ok", data: { primary: openaiWindow(rl?.primary_window), secondary: openaiWindow(rl?.secondary_window) } };
  }
  return { kind: "skip" };
}

async function fetchXaiUsage(): Promise<UsageFetch> {
  const cred = readOAuth("xai");
  if (!cred) return { kind: "skip" };
  const res = await getJson(XAI_BILLING_URL, {
    Authorization: `Bearer ${cred.access}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    Accept: "application/json",
  });
  if (res.kind !== "ok") return res;
  const config = res.body?.config;
  const period = config?.currentPeriod;
  const percent = config?.creditUsagePercent ?? (period ? 0 : undefined);
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return { kind: "skip" };
  const periodEnd = new Date(period?.end ?? config?.billingPeriodEnd ?? NaN).getTime();
  return { kind: "ok", data: { primary: { percent, resetsAt: Number.isFinite(periodEnd) ? periodEnd : undefined } } };
}

async function fetchOpenRouterCredits(): Promise<UsageFetch> {
  const key = readApiKey("openrouter", "OPENROUTER_API_KEY");
  if (!key) return { kind: "skip" };
  const res = await getJson(OPENROUTER_CREDITS_URL, {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  });
  if (res.kind !== "ok") return res;
  const totalCredits = res.body?.data?.total_credits;
  const totalUsage = res.body?.data?.total_usage;
  if (typeof totalCredits !== "number" || typeof totalUsage !== "number") return { kind: "skip" };
  return { kind: "ok", data: { credits: { totalCredits, totalUsage } } };
}

const USAGE_FETCHERS: Record<UsageSource, () => Promise<UsageFetch>> = {
  anthropic: fetchAnthropicUsage,
  openai: fetchOpenAIUsage,
  openrouter: fetchOpenRouterCredits,
  xai: fetchXaiUsage,
};

function formatUsageDelta(resetsAt: number | undefined): string | undefined {
  if (resetsAt === undefined) return undefined;
  const ms = resetsAt - Date.now();
  if (!Number.isFinite(ms)) return undefined;
  if (ms <= 0) return "now";
  const mins = Math.floor(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const minutes = mins % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function usageSourceFor(model: any): UsageSource | undefined {
  if (!model) return undefined;
  const id = String(model.id ?? "").toLowerCase();
  const provider = String(model.provider ?? "").toLowerCase();
  if (provider === "anthropic") return "anthropic";
  if (provider === "openai-codex" || provider === "openai") return "openai";
  if (provider === "openrouter") return "openrouter";
  if (provider === "xai") return "xai";
  if (id.includes("claude")) return "anthropic";
  return undefined;
}

function formatUsage(data: UsageSnapshot): string | undefined {
  const w = data.primary;
  if (!w) return undefined;
  const reset = formatUsageDelta(w.resetsAt);
  return `Usage ${Math.round(w.percent)}%${reset ? ` (reset ${reset})` : ""}`;
}

function formatOpenRouterCredit(credits: UsageSnapshot["credits"], sessionCost: number): string | undefined {
  if (!credits) return undefined;
  const remaining = credits.totalCredits - credits.totalUsage;
  return `A$${(sessionCost * USD_TO_AUD).toFixed(3)} used (A$${(remaining * USD_TO_AUD).toFixed(2)} left)`;
}

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function totalCost(ctx: any): number {
  const entries = ctx.sessionManager?.getEntries?.() ?? [];
  let cost = 0;
  for (const e of entries) {
    if (e.type === "message" && e.message.role === "assistant") {
      cost += e.message.usage?.cost?.total ?? 0;
    } else if (e.type === "message" && e.message.role === "toolResult" && e.message.usage) {
      cost += e.message.usage.cost?.total ?? 0;
    } else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) {
      cost += e.usage.cost?.total ?? 0;
    }
  }
  return cost;
}

function latestCacheHitRate(ctx: any): number | undefined {
  const entries = ctx.sessionManager?.getBranch?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "message" && e.message.role === "assistant" && e.message.usage) {
      const u = e.message.usage;
      const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      return prompt > 0 ? (u.cacheRead / prompt) * 100 : undefined;
    }
  }
  return undefined;
}

function routedProviderFromMetadata(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const chunk = data as {
    provider?: unknown;
    openrouter_metadata?: {
      endpoints?: { available?: Array<{ provider?: unknown; selected?: unknown }> };
      attempts?: Array<{ provider?: unknown }>;
    };
  };
  const metadata = chunk.openrouter_metadata;
  if (metadata) {
    const selected = metadata.endpoints?.available?.find((endpoint) => endpoint?.selected)?.provider;
    if (typeof selected === "string") return selected;
    const attempts = metadata.attempts ?? [];
    const last = attempts[attempts.length - 1]?.provider;
    if (typeof last === "string") return last;
  }
  return typeof chunk.provider === "string" ? chunk.provider : undefined;
}

export default function (pi: ExtensionAPI) {
  let firstToken: number | undefined;
  let tracking = false;
  let tpsText: string | undefined;
  let routedProvider: string | undefined;

  let totalOutput = 0;
  let totalGenMs = 0;

  let lastCtx: any;
  let capturedTui: { requestRender(force?: boolean): void } | undefined;
  let footerInstalled = false;
  let useStatusFallback = false;

  interface UsageState {
    data?: UsageSnapshot;
    fetchedAt: number;
    inFlight?: Promise<void>;
    backoffUntil: number;
    backoffMs: number;
    retryTimer?: ReturnType<typeof setTimeout>;
  }
  const usageState = Object.fromEntries(
    USAGE_SOURCES.map((s) => [s, { fetchedAt: 0, backoffUntil: 0, backoffMs: USAGE_BACKOFF_BASE_MS }]),
  ) as Record<UsageSource, UsageState>;
  let usageTimer: ReturnType<typeof setInterval> | undefined;
  let usageTicker: ReturnType<typeof setInterval> | undefined;

  function activeSource(): UsageSource | undefined {
    return usageSourceFor(lastCtx?.model);
  }

  function adoptDiskCache(source: UsageSource): boolean {
    const st = usageState[source];
    const cache = loadUsageCache(source);
    if (cache && cache.fetchedAt > st.fetchedAt) {
      st.data = cache.data;
      st.fetchedAt = cache.fetchedAt;
      refresh();
    }
    return st.fetchedAt > 0 && Date.now() - st.fetchedAt < USAGE_CACHE_FRESH_MS;
  }

  function refreshUsage(source: UsageSource | undefined, force = false): Promise<void> {
    if (!source) return Promise.resolve();
    const st = usageState[source];
    if (st.inFlight) return st.inFlight;
    const now = Date.now();
    if (now < st.backoffUntil) {
      adoptDiskCache(source);
      return Promise.resolve();
    }
    if (!force && now - st.fetchedAt < USAGE_MIN_REFRESH_MS) return Promise.resolve();
    if (adoptDiskCache(source)) return Promise.resolve();
    st.inFlight = USAGE_FETCHERS[source]()
      .then((result) => {
        if (result.kind === "ok") {
          st.data = result.data;
          st.fetchedAt = Date.now();
          st.backoffMs = USAGE_BACKOFF_BASE_MS;
          saveUsageCache(source, result.data);
        } else if (result.kind === "rate_limited") {
          const wait = Math.max(result.retryAfterMs, st.backoffMs);
          st.backoffUntil = Date.now() + wait;
          st.backoffMs = Math.min(st.backoffMs * 2, USAGE_BACKOFF_MAX_MS);
          adoptDiskCache(source);
          scheduleRetry(source, wait);
        } else {
          adoptDiskCache(source);
        }
        refresh();
      })
      .catch(() => {
        adoptDiskCache(source);
      })
      .finally(() => {
        st.inFlight = undefined;
      });
    return st.inFlight;
  }

  function scheduleRetry(source: UsageSource, afterMs: number) {
    const st = usageState[source];
    if (st.retryTimer) clearTimeout(st.retryTimer);
    st.retryTimer = setTimeout(() => {
      st.retryTimer = undefined;
      if (activeSource() === source) void refreshUsage(source, true);
    }, afterMs + 250);
    st.retryTimer.unref?.();
  }

  function startUsagePolling() {
    const source = activeSource();
    if (source) adoptDiskCache(source);
    void refreshUsage(source, true);
    if (!usageTimer) {
      usageTimer = setInterval(() => void refreshUsage(activeSource(), true), USAGE_POLL_MS);
      usageTimer.unref?.();
    }
    if (!usageTicker) {
      usageTicker = setInterval(refresh, 30_000);
      usageTicker.unref?.();
    }
  }

  function refresh() {
    if (useStatusFallback) {
      lastCtx?.ui?.setStatus?.("tps", tpsText);
    } else {
      capturedTui?.requestRender();
    }
  }

  function installFooter(ctx: any) {
    if (footerInstalled || useStatusFallback) return;
    footerInstalled = true;
    try {
      ctx.ui.setFooter((tui: any, theme: any, _footerData: any) => {
        capturedTui = tui;
        return {
          render(width: number): string[] {
            const c = lastCtx ?? ctx;
            const parts: string[] = [];

            const cacheHit = latestCacheHitRate(c);
            if (cacheHit !== undefined) parts.push(theme.fg("dim", `CH${cacheHit.toFixed(1)}%`));

            const usage = c.getContextUsage?.();
            const contextWindow = usage?.contextWindow ?? c.model?.contextWindow ?? 0;
            const percentValue = usage?.percent ?? 0;
            const percentStr = usage?.percent != null ? `${percentValue.toFixed(1)}%` : "?";
            const tokensStr = usage?.tokens != null ? `${usage.tokens}` : "?";
            const contextDisplay = `${tokensStr}/${formatTokens(contextWindow)} (${percentStr})`;
            const contextColor =
              percentValue > 90 ? "error" : percentValue > 70 ? "warning" : "dim";
            parts.push(theme.fg(contextColor, contextDisplay));

            if (tpsText) parts.push(theme.fg("dim", tpsText));

            const model = c.model;
            const source = usageSourceFor(model);
            const usageData = source && usageState[source].data;
            if (usageData) {
              const usageStr =
                source === "openrouter"
                  ? formatOpenRouterCredit(usageData.credits, totalCost(c))
                  : formatUsage(usageData);
              if (usageStr) parts.push(theme.fg("dim", usageStr));
            }

            const left = parts.join(" ");

            const modelName = model?.id || "no-model";
            let right = modelName;
            if (model?.reasoning) {
              const level = c.thinkingLevel || "off";
              right = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
            }
            if (model?.provider === "openrouter" && routedProvider) {
              const withProvider = `(${routedProvider}) ${right}`;
              if (visibleWidth(left) + 2 + visibleWidth(withProvider) <= width) {
                right = withProvider;
              }
            }
            right = theme.fg("dim", right);

            const leftW = visibleWidth(left);
            const rightW = visibleWidth(right);
            const minPad = 2;

            if (leftW + minPad + rightW <= width) {
              const pad = " ".repeat(width - leftW - rightW);
              return [left + pad + right];
            }

            const availForRight = width - leftW - minPad;
            if (availForRight > 0) {
              const truncated = truncateToWidth(right, availForRight, "");
              const pad = " ".repeat(Math.max(0, width - leftW - visibleWidth(truncated)));
              return [left + pad + truncated];
            }
            return [truncateToWidth(left, width, theme.fg("dim", "..."))];
          },
          dispose() {},
        };
      });
    } catch {
      useStatusFallback = true;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    if (ctx.hasUI && ctx.mode === "tui") installFooter(ctx);
    if (ctx.hasUI) startUsagePolling();
  });

  pi.on("agent_settled", (_event, ctx) => {
    lastCtx = ctx;
    void refreshUsage(activeSource());
  });

  pi.on("model_select", (event, ctx) => {
    lastCtx = ctx;
    routedProvider = undefined;
    const source = usageSourceFor(event.model);
    if (source) adoptDiskCache(source);
    void refreshUsage(source);
    refresh();
  });

  pi.on("session_shutdown", () => {
    if (usageTimer) clearInterval(usageTimer);
    if (usageTicker) clearInterval(usageTicker);
    for (const st of Object.values(usageState)) {
      if (st.retryTimer) clearTimeout(st.retryTimer);
      st.retryTimer = undefined;
    }
    usageTimer = undefined;
    usageTicker = undefined;
  });

  pi.on("agent_start", (_event, ctx) => {
    lastCtx = ctx;
    totalOutput = 0;
    totalGenMs = 0;
  });

  pi.on("message_start", (event, ctx) => {
    lastCtx = ctx;
    if (event.message.role !== "assistant") return;
    if (ctx.hasUI && ctx.mode === "tui") installFooter(ctx);

    firstToken = undefined;
    tracking = true;
    routedProvider = undefined;
    refresh();
  });

  pi.on("provider_stream_event", (event) => {
    if (event.provider !== "openrouter") return;
    const provider = routedProviderFromMetadata(event.data);
    if (provider && provider !== routedProvider) {
      routedProvider = provider;
      refresh();
    }
  });

  pi.on("message_update", (event) => {
    if (!tracking || firstToken !== undefined) return;
    const delta = (event.assistantMessageEvent as any)?.delta;
    if (typeof delta !== "string" || delta.length === 0) return;
    firstToken = Date.now();
  });

  pi.on("message_end", (event, ctx) => {
    lastCtx = ctx;
    if (!tracking || event.message.role !== "assistant" || !ctx.hasUI) return;
    tracking = false;

    const usage = (event.message as any).usage ?? {};
    const output: number = usage.output ?? 0;
    const genMs = Math.max(0, Date.now() - (firstToken ?? Date.now()));
    if (output <= 0 || genMs <= 0) return;

    totalOutput += output;
    totalGenMs += genMs;

    const tps = output / (genMs / 1000);
    const avg = totalOutput / (totalGenMs / 1000);
    tpsText = `${tps.toFixed(1)}tps (${avg.toFixed(1)} avg)`;
    refresh();
  });
}
