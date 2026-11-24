// Resolve the model endpoint used for coaching.
//
// Works with any clai-style launcher that exposes an Anthropic Messages
// endpoint through Claude Code's environment:
//   clds  (DeepSeek):  ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
//   clkc  (Kimi Code): ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY
//   clki  (Kimi):      ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
//   clmm/clza/local/ollama/lmstudio: the same environment shape
// and still works on api.anthropic.com. It never sends a Claude OAuth token
// to a non-Anthropic host, and never sends a DeepSeek key to another provider.

import fs from "node:fs";
import { spawnSync } from "node:child_process";

import { deepseekKeyFile } from "./paths.mjs";

const DEEPSEEK_BASE = "https://api.deepseek.com/anthropic";
const ANTHROPIC_BASE = "https://api.anthropic.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_TIMEOUT_SECONDS = { deepseek: 12, anthropic: 5, kimi: 30, "kimi-code": 30, compatible: 12 };
const DEFAULT_MAX_TOKENS = { kimi: 4096, "kimi-code": 4096 };
const MAX_TIMEOUT_SECONDS = 30;

const CLAI_PROFILE = /claude-(?:deepseek|lds|codex|openai|gemini|grok|local|ollama|lmstudio|minimax|zai|kimi|kimi-code)\b/;

function envValue(env, name) {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function firstEnv(env, names) {
  for (const name of names) {
    const value = envValue(env, name);
    if (value !== null) return { name, value };
  }
  return null;
}

// Provider-neutral names first, then the Claude- and clds-prefixed aliases.
function buddyEnv(env, suffix) {
  return firstEnv(env, [
    `ENGLISH_BUDDY_${suffix}`,
    `CLAUDE_ENGLISH_BUDDY_${suffix}`,
    `CLDS_ENGLISH_BUDDY_${suffix}`,
  ]);
}

function authSchemeOverride(env) {
  const raw = buddyEnv(env, "AUTH_SCHEME")?.value.toLowerCase();
  return raw === "bearer" || raw === "x-api-key" ? raw : null;
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function normalizeEndpoint(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: "Invalid coaching API base URL." };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { error: "Coaching API base URL must use https (or http on loopback)." };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { error: "Coaching API base URL must not contain credentials, a query, or a fragment." };
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    return { error: "Plain-http coaching endpoints are allowed only on loopback." };
  }
  let href = url.href.replace(/\/+$/, "");
  if (href.endsWith("/v1/messages")) {
    return { baseUrl: href.slice(0, -"/v1/messages".length), endpoint: href };
  }
  if (href.endsWith("/v1")) href = href.slice(0, -3);
  // clds uses /anthropic; a bare api.deepseek.com is accepted as a convenience.
  if (url.hostname === "api.deepseek.com" && (href === "https://api.deepseek.com" || href === "http://api.deepseek.com")) {
    href += "/anthropic";
  }
  return { baseUrl: href, endpoint: `${href}/v1/messages` };
}

export function normalizeModel(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .replace(/\[[^\]]*\]\s*$/, "")
    .replace(/^(?:anthropic|deepseek)\//i, "")
    .trim();
}

function familyOf(endpoint, env) {
  let host;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if (host === "api.deepseek.com" || host.endsWith(".deepseek.com") || env.CLDS_PROVIDER === "deepseek") {
    return "deepseek";
  }
  if (host === "api.anthropic.com" || host.endsWith(".anthropic.com")) return "anthropic";
  // Kimi Code and the Kimi/Moonshot platform. Both require thinking (K3 and
  // K3.1 Pro reject thinking:disabled), so they get no thinking field, a
  // larger max_tokens floor, and a longer timeout.
  if (host === "api.kimi.com" || host === "api.kimi.ai" || host.endsWith(".kimi.com") || host.endsWith(".kimi.ai")) {
    return "kimi-code";
  }
  if (host === "api.moonshot.ai" || host === "api.moonshot.cn" || host.endsWith(".moonshot.ai") || host.endsWith(".moonshot.cn")) {
    return "kimi";
  }
  return "compatible";
}

function chooseBase(env) {
  const explicit = buddyEnv(env, "BASE_URL")
    || firstEnv(env, ["ANTHROPIC_BASE_URL"]);
  if (explicit) return { value: explicit.value, source: `env:${explicit.name}` };

  const profile = env.CLAUDE_CONFIG_DIR || "";
  const customProfile = CLAI_PROFILE.test(profile);
  const deepseekProfile = /claude-(?:deepseek|lds)\b/.test(profile);
  if (deepseekProfile) return { value: DEEPSEEK_BASE, source: "clai-default" };
  // Another clai profile (Kimi, Codex, Gemini, ...) without its launcher's
  // base URL: do not silently send its token to api.anthropic.com. A
  // globally exported DEEPSEEK_API_KEY must not hijack that profile either.
  if (customProfile) return { value: null, source: "missing" };
  if (envValue(env, "DEEPSEEK_API_KEY")) {
    return { value: DEEPSEEK_BASE, source: "env:DEEPSEEK_API_KEY" };
  }
  return { value: ANTHROPIC_BASE, source: "default" };
}

function readKeyFile(file) {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

function keychainCredential(env, family) {
  if (family !== "anthropic") return null;
  if (buddyEnv(env, "DISABLE_KEYCHAIN")?.value === "1") {
    return null;
  }
  if (process.platform !== "darwin") return null;

  const result = spawnSync(
    "security",
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.error || result.status !== 0) return null;
  try {
    const creds = JSON.parse(result.stdout.trim());
    const token = creds?.claudeAiOauth?.accessToken;
    const expiresAt = creds?.claudeAiOauth?.expiresAt;
    if (!token) return null;
    return { token, expired: Boolean(expiresAt && Date.now() > expiresAt) };
  } catch {
    return null;
  }
}

function chooseCredential(env, family) {
  const override = authSchemeOverride(env);
  const explicit = buddyEnv(env, "TOKEN");
  if (explicit) {
    return {
      token: explicit.value,
      source: `env:${explicit.name}`,
      scheme: override || "bearer",
    };
  }

  // Claude Code sends this for OAuth and for most custom providers; clds and
  // clki use it for their API keys.
  const authToken = envValue(env, "ANTHROPIC_AUTH_TOKEN");
  if (authToken) {
    return { token: authToken, source: "env:ANTHROPIC_AUTH_TOKEN", scheme: override || "bearer" };
  }

  // clkc and clmm set ANTHROPIC_API_KEY and unset ANTHROPIC_AUTH_TOKEN. Claude
  // Code sends that as x-api-key, which is also what these endpoints expect.
  const apiKey = envValue(env, "ANTHROPIC_API_KEY");
  if (apiKey) {
    const defaultScheme = apiKey.startsWith("sk-ant-oat") ? "bearer" : "x-api-key";
    return {
      token: apiKey,
      source: "env:ANTHROPIC_API_KEY",
      scheme: override || defaultScheme,
    };
  }

  // A DeepSeek key is meaningful only on a DeepSeek endpoint. Never send it
  // to Anthropic, Kimi, or any other provider just because the file exists.
  if (family === "deepseek") {
    const deepseekKey = envValue(env, "DEEPSEEK_API_KEY");
    if (deepseekKey) {
      return { token: deepseekKey, source: "env:DEEPSEEK_API_KEY", scheme: override || "bearer" };
    }

    const file = deepseekKeyFile(env);
    const fileKey = readKeyFile(file);
    if (fileKey) {
      return { token: fileKey, source: "file:deepseek-api-key", scheme: override || "bearer" };
    }
  }

  const keychain = keychainCredential(env, family);
  if (keychain) {
    if (keychain.expired) {
      return {
        token: null,
        source: "keychain:Claude Code-credentials",
        scheme: "bearer",
        error: "The Claude Code OAuth token in the macOS keychain has expired; restart Claude Code to refresh it.",
        failureCode: "oauth-expired",
      };
    }
    return {
      token: keychain.token,
      source: "keychain:Claude Code-credentials",
      scheme: authSchemeOverride(env) || (keychain.token.startsWith("sk-ant-oat") ? "bearer" : "x-api-key"),
    };
  }

  return { token: null, source: "none", scheme: "bearer" };
}

function chooseModel(env, family, config) {
  const explicit = buddyEnv(env, "MODEL");
  const configModel = typeof config?.model === "string" && config.model.trim() !== "" ? config.model.trim() : null;
  const claudeMapped = firstEnv(env, ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_MODEL"]);
  let model = explicit?.value || configModel || claudeMapped?.value || "";
  model = normalizeModel(model);
  if (!model) {
    model = family === "deepseek" ? DEFAULT_DEEPSEEK_MODEL : family === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : "";
  }
  // DeepSeek maps Claude names itself, but an explicit cheap coach model is
  // clearer in history and doctor output.
  if (family === "deepseek" && /^claude-(?:opus|fable|sonnet|haiku)/i.test(model)) {
    model = DEFAULT_DEEPSEEK_MODEL;
  }
  return {
    model,
    source: explicit ? `env:${explicit.name}` : configModel ? "config" : claudeMapped ? `env:${claudeMapped.name}` : "default",
  };
}

function chooseTimeout(env, family, config) {
  const raw = buddyEnv(env, "TIMEOUT_SECONDS");
  const value = raw ? Number(raw.value) : Number(config?.timeout_seconds);
  const fallback = DEFAULT_TIMEOUT_SECONDS[family] ?? DEFAULT_TIMEOUT_SECONDS.compatible;
  if (!Number.isFinite(value) || value <= 0) return { seconds: fallback, source: "default" };
  return { seconds: Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, value)), source: raw ? `env:${raw.name}` : "config" };
}

function chooseThinking(env, family) {
  if (family !== "deepseek") return { value: null, source: "unsupported" };
  const raw = (buddyEnv(env, "THINKING")?.value || "disabled").toLowerCase();
  if (raw === "enabled" || raw === "on") return { value: { type: "enabled" }, source: "env:THINKING" };
  return { value: { type: "disabled" }, source: "default" };
}

function chooseEffort(env, family, config) {
  // Only Kimi Code documents output_config.effort. Kimi K3 always thinks, so
  // "low" keeps the auxiliary coaching call from spending a high-effort budget.
  if (family !== "kimi-code") return { value: null, source: "unsupported" };
  const raw = buddyEnv(env, "EFFORT");
  const configEffort = typeof config?.effort === "string" ? config.effort.toLowerCase() : null;
  const candidate = (raw?.value || configEffort || "low").toLowerCase();
  if (candidate === "none") return { value: null, source: raw ? `env:${raw.name}` : "config" };
  const value = ["low", "high", "max"].includes(candidate) ? candidate : "low";
  return { value, source: raw ? `env:${raw.name}` : configEffort ? "config" : "default" };
}

function chooseMaxTokens(family) {
  return DEFAULT_MAX_TOKENS[family] ?? null;
}

/**
 * @param {{env?: NodeJS.ProcessEnv, config?: object}} options
 */
export function resolveProvider({ env = process.env, config = {} } = {}) {
  const base = chooseBase(env);
  if (!base.value) {
    return {
      ok: false,
      failureCode: "missing-base-url",
      message: "This clai provider profile has no ANTHROPIC_BASE_URL. Start Claude Code through its launcher (clds, clkc, clki, ...) or set ENGLISH_BUDDY_BASE_URL.",
      baseUrl: null,
      baseSource: base.source,
      endpoint: null,
      family: "unknown",
      model: "",
      modelSource: "none",
      timeoutSeconds: null,
      timeoutSource: "none",
      thinking: null,
      thinkingSource: "none",
      effort: null,
      effortSource: "none",
      maxTokens: null,
      credentialSource: "none",
      authScheme: "none",
      hasToken: false,
    };
  }
  const endpoint = normalizeEndpoint(base.value);
  if (endpoint.error) {
    return { ok: false, failureCode: "invalid-base-url", message: endpoint.error, baseUrl: base.value, baseSource: base.source };
  }

  const family = familyOf(endpoint.endpoint, env);
  const credential = chooseCredential(env, family);
  const model = chooseModel(env, family, config);
  const timeout = chooseTimeout(env, family, config);
  const thinking = chooseThinking(env, family);
  const effort = chooseEffort(env, family, config);
  const maxTokens = chooseMaxTokens(family);

  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (credential.token) {
    if (credential.scheme === "x-api-key") headers["x-api-key"] = credential.token;
    else headers.authorization = `Bearer ${credential.token}`;
  }

  const result = {
    ok: Boolean(credential.token),
    failureCode: null,
    message: null,
    family,
    baseUrl: endpoint.baseUrl,
    baseSource: base.source,
    endpoint: endpoint.endpoint,
    model: model.model,
    modelSource: model.source,
    timeoutSeconds: timeout.seconds,
    timeoutSource: timeout.source,
    thinking: thinking.value,
    thinkingSource: thinking.source,
    effort: effort.value,
    effortSource: effort.source,
    maxTokens,
    credentialSource: credential.source,
    authScheme: credential.scheme,
    headers,
    hasToken: Boolean(credential.token),
  };

  if (!credential.token) {
    if (credential.error) {
      result.failureCode = credential.failureCode || "no-credentials";
      result.message = credential.error;
    } else {
      result.failureCode = "no-credentials";
      result.message = family === "deepseek"
        ? "No DeepSeek credential found. Start Claude Code with clds, or set DEEPSEEK_API_KEY."
        : "No coaching credential found for this provider. Start Claude Code through its clai launcher (clds, clkc, clki, ...), or set ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN.";
    }
  }
  if (!result.model) {
    result.ok = false;
    // A missing credential is the more actionable failure; keep it.
    if (!result.failureCode) {
      result.failureCode = "no-model";
      result.message = "No coaching model could be resolved for this endpoint. Set ENGLISH_BUDDY_MODEL or config model.";
    }
  }
  return result;
}

export function sanitizeMessage(message) {
  return String(message ?? "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function failureCodeForStatus(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "upstream-error";
  if (status === 404) return "not-found";
  if (status === 400 || status === 422) return "bad-request";
  return "http-error";
}

/**
 * Call an Anthropic-compatible /v1/messages endpoint.
 *
 * @param {ReturnType<typeof resolveProvider>} provider
 * @param {{system: string, user: string, maxTokens?: number, fetchImpl?: Function, signal?: AbortSignal}} request
 */
export async function callMessages(provider, request) {
  const started = Date.now();
  if (!provider?.ok) {
    return {
      ok: false,
      failureCode: provider?.failureCode || "no-credentials",
      message: provider?.message || "No coaching provider is configured.",
      latencyMs: 0,
    };
  }

  const fetchImpl = request.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return { ok: false, failureCode: "no-fetch", message: "This Node.js runtime has no fetch implementation.", latencyMs: 0 };
  }

  // Kimi K3/K3.1 Pro spend thinking tokens out of max_tokens, so a 1024-token
  // coaching budget can be consumed before any text is produced.
  const maxTokens = Math.max(request.maxTokens ?? 0, provider.maxTokens ?? 0) || 1024;
  const body = {
    model: provider.model,
    max_tokens: maxTokens,
    system: request.system,
    messages: [{ role: "user", content: request.user }],
  };
  if (provider.thinking) body.thinking = provider.thinking;
  if (provider.effort) body.output_config = { effort: provider.effort };

  const timeoutSignal = AbortSignal.timeout(provider.timeoutSeconds * 1000);
  const signal = request.signal
    ? (typeof AbortSignal.any === "function" ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal)
    : timeoutSignal;

  let response;
  try {
    response = await fetchImpl(provider.endpoint, {
      method: "POST",
      headers: provider.headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      failureCode: timedOut ? "timeout" : "network",
      message: timedOut
        ? `Coaching request timed out after ${provider.timeoutSeconds}s.`
        : `Coaching request failed: ${sanitizeMessage(error?.message || error)}`,
      latencyMs: Date.now() - started,
    };
  }

  let raw;
  try {
    raw = await response.text();
  } catch (error) {
    return {
      ok: false,
      failureCode: "network",
      message: `Could not read the coaching response: ${sanitizeMessage(error?.message || error)}`,
      latencyMs: Date.now() - started,
    };
  }

  let json;
  try {
    json = raw.trim() === "" ? null : JSON.parse(raw);
  } catch {
    return {
      ok: false,
      failureCode: "bad-response",
      message: `Coaching endpoint returned non-JSON (HTTP ${response.status}).`,
      status: response.status,
      latencyMs: Date.now() - started,
    };
  }

  if (!response.ok || (json && (json.type === "error" || json.error))) {
    const upstream = json?.error?.message || json?.message || `HTTP ${response.status}`;
    return {
      ok: false,
      failureCode: failureCodeForStatus(response.status),
      message: sanitizeMessage(upstream),
      status: response.status,
      latencyMs: Date.now() - started,
    };
  }
  if (!json) {
    return { ok: false, failureCode: "empty-output", message: "Coaching endpoint returned an empty body.", status: response.status, latencyMs: Date.now() - started };
  }

  const blocks = Array.isArray(json.content) ? json.content : [];
  const text = typeof json.content === "string"
    ? json.content.trim()
    : blocks
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
  const hasThinking = blocks.some((block) => block && block.type === "thinking");

  if (text === "") {
    return {
      ok: false,
      failureCode: hasThinking ? "non-text-output" : "empty-output",
      message: hasThinking
        ? "The coaching model returned only thinking blocks. Keep thinking disabled or raise the timeout."
        : "The coaching model returned no text.",
      status: response.status,
      latencyMs: Date.now() - started,
    };
  }
  if (json.stop_reason === "max_tokens") {
    return {
      ok: false,
      failureCode: "max-tokens",
      message: "The coaching response hit max_tokens before it finished.",
      status: response.status,
      latencyMs: Date.now() - started,
    };
  }

  return {
    ok: true,
    text,
    stopReason: json.stop_reason || null,
    model: json.model || provider.model,
    usage: json.usage || null,
    status: response.status,
    latencyMs: Date.now() - started,
  };
}

export function describeProvider(provider) {
  return {
    family: provider.family,
    baseUrl: provider.baseUrl,
    endpoint: provider.endpoint,
    baseSource: provider.baseSource,
    model: provider.model,
    modelSource: provider.modelSource,
    timeoutSeconds: provider.timeoutSeconds,
    timeoutSource: provider.timeoutSource,
    thinking: provider.thinking?.type || "not-sent",
    effort: provider.effort || "not-sent",
    effortSource: provider.effortSource,
    maxTokens: provider.maxTokens,
    credentialSource: provider.credentialSource,
    authScheme: provider.authScheme,
    hasToken: provider.hasToken,
  };
}

export { DEEPSEEK_BASE, ANTHROPIC_BASE };
