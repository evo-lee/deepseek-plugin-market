import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  callMessages,
  describeProvider,
  normalizeModel,
  resolveProvider,
  sanitizeMessage,
} from "../scripts/lib/provider.mjs";

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceb-provider-"));
  return {
    dir,
    env(overrides = {}) {
      return {
        PATH: process.env.PATH,
        HOME: path.join(dir, "home"),
        XDG_CONFIG_HOME: path.join(dir, "xdg"),
        CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
        CLDS_ENGLISH_BUDDY_DISABLE_KEYCHAIN: "1",
        ...overrides,
      };
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("clds environment resolves the DeepSeek endpoint, token and model", () => {
  const h = tempHome();
  try {
    const provider = resolveProvider({
      env: h.env({
        CLAUDE_CONFIG_DIR: "/Users/test/.claude-deepseek",
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: "deepseek-secret",
        ANTHROPIC_MODEL: "deepseek-flash[1m]",
      }),
    });
    assert.equal(provider.ok, true);
    assert.equal(provider.family, "deepseek");
    assert.equal(provider.endpoint, "https://api.deepseek.com/anthropic/v1/messages");
    assert.equal(provider.model, "deepseek-flash");
    assert.equal(provider.credentialSource, "env:ANTHROPIC_AUTH_TOKEN");
    assert.equal(provider.authScheme, "bearer");
    assert.equal(provider.headers.authorization, "Bearer deepseek-secret");
    assert.equal(provider.headers["x-api-key"], undefined);
    assert.deepEqual(provider.thinking, { type: "disabled" });
    assert.equal(provider.timeoutSeconds, 12);
    assert.equal(JSON.stringify(describeProvider(provider)).includes("deepseek-secret"), false);
  } finally {
    h.cleanup();
  }
});

test("clds profile with no explicit base defaults to DeepSeek", () => {
  const h = tempHome();
  try {
    const provider = resolveProvider({
      env: h.env({ CLAUDE_CONFIG_DIR: "/Users/test/.claude-deepseek", ANTHROPIC_AUTH_TOKEN: "x" }),
    });
    assert.equal(provider.family, "deepseek");
    assert.equal(provider.baseSource, "clds-default");
  } finally {
    h.cleanup();
  }
});

test("Anthropic API key uses x-api-key and the Haiku default", () => {
  const h = tempHome();
  try {
    const provider = resolveProvider({
      env: h.env({
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_API_KEY: "sk-ant-api03-test",
      }),
    });
    assert.equal(provider.family, "anthropic");
    assert.equal(provider.authScheme, "x-api-key");
    assert.equal(provider.headers["x-api-key"], "sk-ant-api03-test");
    assert.equal(provider.model, "claude-haiku-4-5-20251001");
    assert.equal(provider.thinking, null);
  } finally {
    h.cleanup();
  }
});

test("a non-Anthropic endpoint never consumes a keychain credential", () => {
  const h = tempHome();
  try {
    const provider = resolveProvider({
      env: h.env({ ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", HOME: path.join(h.dir, "home") }),
    });
    assert.equal(provider.ok, false);
    assert.equal(provider.failureCode, "no-credentials");
    assert.equal(provider.credentialSource, "none");
    assert.equal(provider.hasToken, false);
  } finally {
    h.cleanup();
  }
});

test("the private DeepSeek key file is read without an environment key", () => {
  const h = tempHome();
  try {
    const file = path.join(h.dir, "xdg", "claude-driven-ai-providers", "deepseek-api-key");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "file-secret\n", { mode: 0o600 });
    const provider = resolveProvider({
      env: h.env({ ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" }),
    });
    assert.equal(provider.ok, true);
    assert.equal(provider.credentialSource, "file:deepseek-api-key");
    assert.equal(provider.headers.authorization, "Bearer file-secret");
  } finally {
    h.cleanup();
  }
});

test("a DeepSeek key file is never sent to api.anthropic.com", () => {
  const h = tempHome();
  try {
    const file = path.join(h.dir, "xdg", "claude-driven-ai-providers", "deepseek-api-key");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "file-secret\n", { mode: 0o600 });
    const provider = resolveProvider({
      env: h.env({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }),
    });
    assert.equal(provider.ok, false);
    assert.equal(provider.failureCode, "no-credentials");
    assert.equal(provider.credentialSource, "none");
  } finally {
    h.cleanup();
  }
});

test("a non-DeepSeek clai profile without a base URL fails closed", () => {
  const h = tempHome();
  try {
    const provider = resolveProvider({
      env: h.env({ CLAUDE_CONFIG_DIR: "/Users/test/.claude-kimi", ANTHROPIC_AUTH_TOKEN: "kimi-token" }),
    });
    assert.equal(provider.ok, false);
    assert.equal(provider.failureCode, "missing-base-url");
    assert.equal(provider.hasToken, false);
  } finally {
    h.cleanup();
  }
});

test("bad base URLs are rejected, loopback http is allowed", () => {
  const h = tempHome();
  try {
    const bad = resolveProvider({ env: h.env({ ANTHROPIC_BASE_URL: "http://example.com" }) });
    assert.equal(bad.ok, false);
    assert.equal(bad.failureCode, "invalid-base-url");

    const loopback = resolveProvider({
      env: h.env({ ANTHROPIC_BASE_URL: "http://127.0.0.1:1234", ANTHROPIC_AUTH_TOKEN: "x" }),
    });
    assert.equal(loopback.endpoint, "http://127.0.0.1:1234/v1/messages");
    assert.equal(loopback.family, "compatible");
  } finally {
    h.cleanup();
  }
});

test("normalizeModel strips context suffixes and provider prefixes", () => {
  assert.equal(normalizeModel("deepseek-flash[1m]"), "deepseek-flash");
  assert.equal(normalizeModel(" anthropic/claude-haiku "), "claude-haiku");
  assert.equal(normalizeModel(""), "");
});

function provider(env) {
  return resolveProvider({ env });
}

test("callMessages sends the Anthropic messages shape and reads text", async () => {
  const h = tempHome();
  try {
    const p = provider(h.env({ ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "x" }));
    let seen;
    const result = await callMessages(p, {
      system: "system",
      user: "hello",
      maxTokens: 32,
      fetchImpl: async (url, init) => {
        seen = { url, init, body: JSON.parse(init.body) };
        return new Response(JSON.stringify({
          type: "message",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          model: "deepseek-flash",
          usage: { input_tokens: 3, output_tokens: 1 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.text, "ok");
    assert.equal(seen.url, "https://api.deepseek.com/anthropic/v1/messages");
    assert.equal(seen.body.model, "deepseek-flash");
    assert.deepEqual(seen.body.thinking, { type: "disabled" });
    assert.equal(seen.init.headers.authorization, "Bearer x");
  } finally {
    h.cleanup();
  }
});

test("callMessages maps auth failures without leaking the key", async () => {
  const h = tempHome();
  try {
    const p = provider(h.env({ ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "x" }));
    const result = await callMessages(p, {
      system: "s",
      user: "u",
      fetchImpl: async () => new Response(JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "invalid key sk-secret123456" },
      }), { status: 401 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureCode, "auth");
    assert.equal(result.message.includes("sk-secret123456"), false);
  } finally {
    h.cleanup();
  }
});

test("callMessages rejects truncated and thinking-only responses", async () => {
  const h = tempHome();
  try {
    const p = provider(h.env({ ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "x" }));
    const truncated = await callMessages(p, {
      system: "s",
      user: "u",
      fetchImpl: async () => new Response(JSON.stringify({
        content: [{ type: "text", text: "partial" }],
        stop_reason: "max_tokens",
      }), { status: 200 }),
    });
    assert.equal(truncated.failureCode, "max-tokens");

    const thinking = await callMessages(p, {
      system: "s",
      user: "u",
      fetchImpl: async () => new Response(JSON.stringify({
        content: [{ type: "thinking", thinking: "..." }],
        stop_reason: "end_turn",
      }), { status: 200 }),
    });
    assert.equal(thinking.failureCode, "non-text-output");
  } finally {
    h.cleanup();
  }
});

test("callMessages reports timeouts and sanitizes messages", async () => {
  const h = tempHome();
  try {
    const p = provider(h.env({ ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "x" }));
    const result = await callMessages(p, {
      system: "s",
      user: "u",
      fetchImpl: async () => {
        const error = new Error("aborted");
        error.name = "TimeoutError";
        throw error;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureCode, "timeout");
    assert.equal(sanitizeMessage("Bearer abcdefghijklmnop sk-1234567890abcdef"), "Bearer *** sk-***");
  } finally {
    h.cleanup();
  }
});
