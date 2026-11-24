// Resolve the model endpoint used for coaching.
//
// clds starts Claude Code with:
//   ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
//   ANTHROPIC_AUTH_TOKEN=<DEEPSEEK_API_KEY>
// and explicitly unsets ANTHROPIC_API_KEY. The upstream english-buddy hook
// only knew ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN, so it reported "no
// credentials" under clds and never coached. This module understands the clds
// environment, keeps working on api.anthropic.com, and never sends a Claude
// OAuth token to a non-Anthropic host.

import fs from "node:fs";
import { spawnSync } from "node:child_process";

import { deepseekKeyFile } from "./paths.mjs";

const DEEPSEEK_BASE = "https://api.deepseek.com/anthropic";
const ANTHROPIC_BASE = "https://api.anthropic.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_TIMEOUT_SECONDS = { deepseek: 12, anthropic: 5, compatible: 12 };
const MAX_TIMEOUT_SECONDS = 30;

const CLDS_PROFILE = /claude-(?:deepseek|lds|codex|openai|gemini|grok|local|ollama|lmstudio|minimax|zai|kimi|kimi-code)\b/;

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
  return "compatible";
}

function chooseBase(env) {
  const explicit = firstEnv(env, [
    "CLDS_ENGLISH_BUDDY_BASE_URL",
    "CLAUDE_ENGLISH_BUDDY_BASE_URL",
    "ANTHROPIC_BASE_URL",
  ]);
  if (explicit) return { value: explicit.value, source: `env:${explicit.name}` };

  const customProfile = CLDS_PROFILE.test(env.CLAUDE_CONFIG_DIR || "");
  const deepseekProfile = /claude-(?:deepseek|lds)\b/.test(env.CLAUDE_CONFIG_DIR || "");
  if (deepseekProfile || envValue(env, "DEEPSEEK_API_KEY")) {
    return { value: DEEPSEEK_BASE, source: "clds-default" };
  }
  // Another clai profile (Kimi, Codex, Gemini, ...) without its launcher's
  // base URL: do not silently send its token to api.anthropic.com.
  if (customProfile) return { value: null, source: "missing" };
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
  if (env.CLDS_ENGLISH_BUDDY_DISABLE_KEYCHAIN === "1" || env.CLAUDE_ENGLISH_BUDDY_DISABLE_KEYCHAIN === "1") {
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
  const explicit = firstEnv(env, ["CLDS_ENGLISH_BUDDY_TOKEN", "CLAUDE_ENGLISH_BUDDY_TOKEN"]);
  if (explicit) {
    const scheme = (env.CLDS_ENGLISH_BUDDY_AUTH_SCHEME || "bearer").toLowerCase();
    return {
      token: explicit.value,
      source: `env:${explicit.name}`,
      scheme: scheme === "x-api-key" ? "x-api-key" : "bearer",
    };
  }

  // Claude Code sends this for OAuth and for custom providers; clds uses it
  // for the DeepSeek API key.
  const authToken = envValue(env, "ANTHROPIC_AUTH_TOKEN");
  if (authToken) {
    return { token: authToken, source: "env:ANTHROPIC_AUTH_TOKEN", scheme: "bearer" };
  }

  const apiKey = envValue(env, "ANTHROPIC_API_KEY");
  if (apiKey) {
    return {
      token: apiKey,
      source: "env:ANTHROPIC_API_KEY",
      scheme: apiKey.startsWith("sk-ant-oat") ? "bearer" : family === "anthropic" ? "x-api-key" : "bearer",
    };
  }

  // A DeepSeek key is only meaningful on a non-Anthropic endpoint. Never send
  // it to api.anthropic.com just because the file exists.
  if (family !== "anthropic") {
    const deepseekKey = envValue(env, "DEEPSEEK_API_KEY");
    if (deepseekKey) {
      return { token: deepseekKey, source: "env:DEEPSEEK_API_KEY", scheme: "bearer" };
    }

    const file = deepseekKeyFile(env);
    const fileKey = readKeyFile(file);
    if (fileKey) {
      return { token: fileKey, source: "file:deepseek-api-key", scheme: "bearer" };
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
      scheme: keychain.token.startsWith("sk-ant-oat") ? "bearer" : "x-api-key",
    };
  }

  return { token: null, source: "none", scheme: "bearer" };
}

function chooseModel(env, family, config) {
  const explicit = firstEnv(env, ["CLDS_ENGLISH_BUDDY_MODEL", "CLAUDE_ENGLISH_BUDDY_MODEL"]);
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
  const raw = firstEnv(env, [
    "CLDS_ENGLISH_BUDDY_TIMEOUT_SECONDS",
    "CLAUDE_ENGLISH_BUDDY_TIMEOUT_SECONDS",
  ]);
  const value = raw ? Number(raw.value) : Number(config?.timeout_seconds);
  const fallback = DEFAULT_TIMEOUT_SECONDS[family] ?? DEFAULT_TIMEOUT_SECONDS.compatible;
  if (!Number.isFinite(value) || value <= 0) return { seconds: fallback, source: "default" };
  return { seconds: Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, value)), source: raw ? `env:${raw.name}` : "config" };
}

function chooseThinking(env, family) {
  if (family !== "deepseek") return { value: null, source: "unsupported" };
  const raw = (env.CLDS_ENGLISH_BUDDY_THINKING || "disabled").toLowerCase();
  if (raw === "enabled" || raw === "on") return { value: { type: "enabled" }, source: "env:CLDS_ENGLISH_BUDDY_THINKING" };
  return { value: { type: "disabled" }, source: "default" };
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
      message: "This clai provider profile has no ANTHROPIC_BASE_URL. Start Claude Code through its launcher (for example clds) or set CLDS_ENGLISH_BUDDY_BASE_URL.",
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
        : "No coaching credential found. Set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or sign in to Claude Code.";
    }
  }
  if (!result.model) {
    result.ok = false;
    result.failureCode = "no-model";
    result.message = "No coaching model could be resolved for this endpoint. Set CLDS_ENGLISH_BUDDY_MODEL.";
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

  const body = {
    model: provider.model,
    max_tokens: request.maxTokens ?? 1024,
    system: request.system,
    messages: [{ role: "user", content: request.user }],
  };
  if (provider.thinking) body.thinking = provider.thinking;

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
    credentialSource: provider.credentialSource,
    authScheme: provider.authScheme,
    hasToken: provider.hasToken,
  };
}

export { DEEPSEEK_BASE, ANTHROPIC_BASE };
