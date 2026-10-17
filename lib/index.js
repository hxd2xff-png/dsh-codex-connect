/**
 * dsh-codex-connect
 *
 * 把本地 Codex CLI 已登录的 ChatGPT 订阅模型接入 DeepSeek Harness。
 * 复用 ~/.codex/auth.json 的 ChatGPT 登录态（auth_mode=chatgpt），
 * 不启动任何独立 OAuth 流程，不产生任何新费用。
 *
 * 架构（参照 dsh-workbuddy-connect@0.7.3 的接入方式）：
 *   DSH → ctx.llm.registerAdapter → PiAiAdapter → pi-ai provider
 *       → openAICodexResponsesApi → https://chatgpt.com/backend-api/codex/responses
 *
 * 凭据：只读 ~/.codex/auth.json（Codex CLI 是身份权威）。
 * 刷新：Codex CLI 使用时会自动续期 auth.json；本插件只读不写。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";

export const name = "llm-codex-connect";
export const inject = ["llm", "webServer"];

/** 插件配置（可在 cordis.patch.yml 里覆盖） */
export const Config = z.object({
  authFile: z.string(),
  displayName: z.string(),
  pollMs: z.number(),
}).description("dsh-codex-connect config");

const PROVIDER_ID = "codex-subscription";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const RENEW_AHEAD_MS = 5 * 60 * 1000;

function defaultAuthPath() {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
}

function decodeJwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function parseAuth(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("dsh-codex-connect: auth.json 不是合法 JSON");
  }
  if (doc.auth_mode && doc.auth_mode !== "chatgpt") {
    throw new Error("dsh-codex-connect: 需要 auth_mode=chatgpt，当前=" + doc.auth_mode);
  }
  const tokens = doc.tokens;
  if (!tokens?.access_token) {
    throw new Error("dsh-codex-connect: auth.json 没有 access_token（API key 模式无法走订阅路由）");
  }
  const claims = decodeJwtPayload(tokens.access_token);
  const authClaim = claims["https://api.openai.com/auth"] ?? {};
  const accountId = tokens.account_id ?? authClaim.chatgpt_account_id;
  if (!accountId || typeof claims.exp !== "number") {
    throw new Error("dsh-codex-connect: 凭据缺少账号 ID 或有效期");
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    accountId,
    expiresAtMs: claims.exp * 1000,
  };
}

class CodexCredentialStore {
  constructor(path, logger) {
    this.path = path;
    this.logger = logger;
    this.cached = null;
  }

  current() {
    if (!existsSync(this.path)) return null;
    let mtimeMs;
    try { mtimeMs = statSync(this.path).mtimeMs; } catch { return null; }
    if (this.cached && this.cached.fileMtimeMs === mtimeMs) {
      return this.cached.credential;
    }
    const credential = parseAuth(readFileSync(this.path, "utf8"));
    this.cached = { credential, fileMtimeMs: mtimeMs };
    return credential;
  }

  async resolve() {
    const credential = this.current();
    if (!credential) {
      throw new Error(
        "dsh-codex-connect: 找不到 " + this.path +
        "。请先安装并登录 Codex CLI（codex.cmd login，选 Sign in with ChatGPT）"
      );
    }
    if (credential.expiresAtMs <= Date.now()) {
      throw new Error(
        "dsh-codex-connect: Codex 登录态已过期。请运行一次 codex.cmd exec \"hi\" 让 CLI 续期后重试"
      );
    }
    if (credential.expiresAtMs < Date.now() + RENEW_AHEAD_MS) {
      this.logger?.info?.("dsh-codex-connect: access token 临近过期，插件只读，等 Codex CLI 续期");
    }
    return credential;
  }
}

// 权威来源：~/.codex/models_cache.json（Codex 客户端从服务端拉取）。
// 只保留 visibility=list 的模型（hide 的不在选择器展示）。
// 已退役的 gpt-5.3-codex-spark（2026-09-14 退役）已移除。
// 档位依据**本机实测**（不是照抄 models_cache.json）：
//   low/medium/high/xhigh/max -> 200 正常回复
//   ultra                     -> 400 Invalid value（服务端不支持，客户端清单里的 ultra 是客户端概念）
//   none/minimal              -> 200 但回复为空（等同关闭推理），故不对外提供
// visibility=hide 的模型与已退役的 gpt-5.3-codex-spark 均不列出。
const FALLBACK_MODELS = [
  { id: "gpt-6.1-sol",   name: "GPT-6.1 Sol",   contextWindow: 272000, maxTokens: 128000, supportsImages: true, defaultEffort: "low",    efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-astra",   name: "GPT-6 Astra",   contextWindow: 272000, maxTokens: 128000, supportsImages: true, defaultEffort: "low",    efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-sol",     name: "GPT-6 Sol",     contextWindow: 272000, maxTokens: 128000, supportsImages: true, defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-luna",    name: "GPT-6 Luna",    contextWindow: 272000, maxTokens: 128000, supportsImages: true, defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.6-sol",   name: "GPT-5.6 Sol",   contextWindow: 272000, maxTokens: 128000, supportsImages: true, defaultEffort: "low",    efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextWindow: 272000, maxTokens: 128000, supportsImages: true, defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.6-luna",  name: "GPT-5.6 Luna",  contextWindow: 272000, maxTokens: 128000, supportsImages: true, defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
];

/**
 * Build the pi-ai reasoning declaration for one model.
 *
 * DSH renders the effort choices from `reasoning.supportedEfforts`; the
 * thinkingLevelMap only renames the wire spelling (identity here, because the
 * Codex backend accepts the same level names we expose).
 *
 * "off" is intentionally NOT advertised: the backend rejects a "none" effort
 * for these models, and pi-ai treats an explicit off as unsupported.
 */
/**
 * Build the pi-ai reasoning declaration for one model.
 *
 * CRITICAL — field placement (verified against pi-ai 0.87.1):
 *
 *   pi-ai reads \`model.thinkingLevelMap\` from the MODEL object, and
 *   pi-ai reads \`model.reasoning\` as a BOOLEAN. It does not look inside a
 *   reasoning object. When thinkingLevelMap is nested under \`reasoning\`,
 *   pi-ai sees \`undefined\` at the top level, and its filter treats
 *   \`undefined !== null\` as "available" — so \`off\` and \`minimal\` leak into
 *   the picker, and selecting off makes pi-ai send \`effort: "none"\`
 *   (openai-codex-responses.js:427), which the Codex backend rejects with
 *   "Unsupported value: 'none'".
 *
 *   With thinkingLevelMap at the top level and \`off: null\`, the guard at
 *   line 427 evaluates false and no reasoning field is sent.
 *
 * DSH additionally renders picker choices from \`supportedEfforts\` /
 * \`defaultEffort\`, so those stay alongside the map.
 */
function reasoningFor(model) {
  return {
    supports: model.efforts.length > 0,
    supportedEfforts: model.efforts.slice(),
    defaultEffort: model.defaultEffort,
    // Unsupported tiers are pinned to null so pi-ai's filter drops them;
    // supported tiers map to their own wire spelling.
    thinkingLevelMap: Object.assign(
      { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
      Object.fromEntries(model.efforts.map((e) => [e, e]))
    ),
  };
}

const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return []; },
    async modify() { throw new Error("dsh-codex-connect: 登录态由 Codex CLI 管理"); },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() { return false; },
  },
};

/* ------------------------------------------------------------------ */
/* Proxy: neither Node fetch nor pi-ai reads the Windows system proxy.    */
/* ------------------------------------------------------------------ */

/**
 * Resolve the proxy to dial chatgpt.com through, or null for a direct
 * connection. Environment variables win (they are explicit); otherwise the
 * Windows "Internet Settings" registry key is consulted, because that is where
 * the system proxy actually lives.
 */
function resolveProxyUrl() {
  const env = process.env;
  const explicit = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy;
  if (explicit) return explicit;
  if (process.platform !== "win32") return null;
  try {
    const settings = execFileSync("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], {
      encoding: "utf8", windowsHide: true, timeout: 3000,
    });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(settings)) return null;
    const server = settings.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
    if (!server) return null;
    const address = server.includes("=")
      ? server.split(";").map((s) => s.trim()).find((s) => s.startsWith("https="))?.slice(6)
      : server;
    return address ? (/^https?:\/\//i.test(address) ? address : "http://" + address) : null;
  } catch {
    return null; // No readable system proxy: keep direct access on other setups.
  }
}

/**
 * A fetch that honours `proxy`. Undici is loaded lazily so a direct-connection
 * setup never pays for it, and fetch plus ProxyAgent come from the same undici
 * instance (mixing them across versions fails with UND_ERR_INVALID_ARG).
 */
function createProxyFetch(proxy) {
  let transport = null;
  const open = () => {
    transport ??= import("undici").then(({ fetch, ProxyAgent }) => ({ fetch, dispatcher: new ProxyAgent(proxy) }));
    return transport;
  };
  const proxyFetch = async (input, init) => {
    const { fetch, dispatcher } = await open();
    return fetch(input, { ...init, dispatcher });
  };
  proxyFetch.close = () => transport?.then((client) => client.dispatcher.close()).catch(() => {});
  return proxyFetch;
}

/** Enough of the pi-ai api surface to keep the provider contract intact. */
function withProxy(api, proxyFetch) {
  return {
    stream: (model, context, options) =>
      api.stream(model, context, { ...options, fetch: proxyFetch, transport: "sse" }),
    streamSimple: (model, context, options) =>
      api.streamSimple(model, context, { ...options, fetch: proxyFetch, transport: "sse" }),
  };
}

/* ------------------------------------------------------------------ */
/* Usage query: https://chatgpt.com/backend-api/wham/usage                */
/* ------------------------------------------------------------------ */

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_PATH = "/plugins/dsh-codex-connect/usage";

/** 60s in-memory cache so the composer badge never hammers upstream. */
function createUsageStore(credentials, proxyFetch) {
  let cache = null;
  const TTL_MS = 60_000;
  return {
    async read(force) {
      if (!force && cache && Date.now() - cache.fetchedAtMs < TTL_MS) return cache.data;
      const credential = await credentials.resolve();
      const fetchUsage = proxyFetch ?? globalThis.fetch;
      const res = await fetchUsage(USAGE_URL, {
        signal: AbortSignal.timeout(20_000),
        headers: {
          Authorization: "Bearer " + credential.accessToken,
          "chatgpt-account-id": credential.accountId,
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error("Codex usage query failed (" + res.status + "): " + text.slice(0, 200));
      }
      const json = await res.json();
      const rl = json?.rate_limit ?? {};
      const win = (w) => w ? {
        usedPercent: w.used_percent ?? null,
        windowSeconds: w.limit_window_seconds ?? null,
        resetAfterSeconds: w.reset_after_seconds ?? null,
      } : null;
      const data = {
        planType: json?.plan_type ?? null,
        allowed: rl.allowed !== false,
        limitReached: rl.limit_reached === true,
        primary: win(rl.primary_window),
        secondary: win(rl.secondary_window),
      };
      cache = { data, fetchedAtMs: Date.now() };
      return data;
    },
    invalidate() { cache = null; },
    // The dispatcher is owned by the provider route; only the cache dies here.
    close() { cache = null; },
  };
}

/** Same-origin route the browser half fetches; no secret crosses the wire. */
function registerUsageRoute(ctx, usageStore) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "exact",
      path: USAGE_PATH,
      handler: async (req, res) => {
        const send = (code, body) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.method !== "GET") return send(405, { error: "method not allowed" });
        try {
          send(200, await usageStore.read(req.url?.includes("force=1")));
        } catch (error) {
          send(502, { error: String(error?.message ?? error) });
        }
      },
    });
    return () => { dispose(); usageStore.close(); };
  }, "dsh-codex-connect: usage route");
}

function createCodexRoute({ credentials, displayName, logger, ctx }) {
  // Both chat streaming and the usage badge need the same proxy decision.
  const proxy = resolveProxyUrl();
  const proxyFetch = proxy ? createProxyFetch(proxy) : null;
  logger?.info?.(
    "dsh-codex-connect: " + (proxy
      ? "检测到代理 " + proxy + "（订阅流量与用量查询都走它）"
      : "未检测到代理，直连 chatgpt.com")
  );

  const buildModels = () =>
    FALLBACK_MODELS.map((m) => {
      const reasoning = reasoningFor(m);
      return {
        id: m.id,
        name: m.name,
        provider: PROVIDER_ID,
        api: "openai-codex-responses",
        baseUrl: CODEX_BASE_URL,
        input: m.supportsImages ? ["text", "image"] : ["text"],
        // pi-ai wants a boolean here and reads thinkingLevelMap from the
        // model's top level — see reasoningFor() for why that matters.
        reasoning: reasoning.supports,
        thinkingLevelMap: reasoning.thinkingLevelMap,
        // DSH renders the picker from these two.
        supportedEfforts: reasoning.supportedEfforts,
        defaultEffort: reasoning.defaultEffort,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    });

  const provider = {
    ...createProvider({
      id: PROVIDER_ID,
      name: displayName,
      baseUrl: CODEX_BASE_URL,
      auth: { apiKey: {
        name: "Codex ChatGPT access token",
        async resolve({ credential }) {
          const apiKey = credential?.key;
          return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
            auth: { apiKey },
            source: "Codex CLI (ChatGPT subscription)",
          };
        },
      } },
      models: buildModels(),
      // pi-ai dials with globalThis.fetch unless given options.fetch, and never
      // reads the Windows system proxy — so the proxy is injected here.
      api: proxyFetch ? withProxy(openAICodexResponsesApi(), proxyFetch) : openAICodexResponsesApi(),
    }),
    getModels: buildModels,
  };

  const profile = {
    provider: PROVIDER_ID,
    displayName,
    streamIdleTimeoutMs: 300_000,
    retryPolicy: resolveRetryPolicy(undefined, "dsh-codex-connect retryPolicy"),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    maxRequestImageBytes: 20_971_520,
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
    piProvider: provider,
  };

  let profiles = new Map([[PROVIDER_ID, profile]]);

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => (await credentials.resolve()).accessToken,
    // 图片输入需要 durable attachment service（缺这两项会报 UNSUPPORTED_CONTENT）
    resolveAttachments: () => ctx.get("attachments"),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(
        attachments,
        (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath),
        ref
      ),
  });

  return {
    adapter,
    proxyFetch,
    invalidate() {
      profiles = new Map([[PROVIDER_ID, profile]]);
    },
  };
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? console;
  const authPath = config?.authFile || defaultAuthPath();
  const displayName = config?.displayName ?? "Codex · ChatGPT 订阅";

  const credentials = new CodexCredentialStore(authPath, logger);
  const route = createCodexRoute({ credentials, displayName, logger, ctx });

  // 会员用量：60s 缓存 + 同源 HTTP 路由（浏览器不接触任何 token）
  registerUsageRoute(ctx, createUsageStore(credentials, route.proxyFetch));

  const pollMs = config?.pollMs ?? 30_000;
  let lastKnown = null;
  const timer = setInterval(() => {
    let has = false;
    try { has = credentials.current() !== null; } catch { has = false; }
    if (has !== lastKnown) {
      lastKnown = has;
      route.invalidate();
      try { ctx.emit("llm/adapters-updated"); } catch {}
      logger.info?.("dsh-codex-connect: 登录态变化 → " + (has ? "已就绪" : "未检测到"));
    }
  }, pollMs);

  const release = ctx.llm.registerAdapter([PROVIDER_ID], route.adapter);

  const ready = credentials.current() !== null;
  lastKnown = ready;
  logger.info?.(
    "dsh-codex-connect: provider '" + PROVIDER_ID + "' 已注册（" + FALLBACK_MODELS.length +
    " 个订阅模型）；凭据 " + (ready ? "已就绪（复用本地 Codex CLI 登录态）" : "未找到——先登录 Codex CLI")
  );

  ctx.effect(() => () => {
    clearInterval(timer);
    release();
    route.proxyFetch?.close?.();
  });
}
