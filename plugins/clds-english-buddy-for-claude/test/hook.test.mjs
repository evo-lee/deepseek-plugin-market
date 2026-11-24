import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { localDate } from "../scripts/lib/state.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "prompt-coach-hook.mjs");

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceb-hook-"));
  const project = path.join(dir, "project");
  fs.mkdirSync(project, { recursive: true });
  return {
    dir,
    project,
    data: path.join(dir, "data"),
    env(port, overrides = {}) {
      return {
        PATH: process.env.PATH,
        HOME: path.join(dir, "home"),
        XDG_CONFIG_HOME: path.join(dir, "xdg"),
        CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
        CLAUDE_PLUGIN_DATA: path.join(dir, "data"),
        CLDS_ENGLISH_BUDDY_DISABLE_KEYCHAIN: "1",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_AUTH_TOKEN: "test-token",
        CLDS_ENGLISH_BUDDY_MODEL: "test-model",
        ...overrides,
      };
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function runHook(workspace, prompt, env, session = "test-session") {
  // Async spawn, not spawnSync: the test's HTTP server lives in this process,
  // and spawnSync would block the event loop so the hook could never connect.
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: workspace.project,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ status: null, stdout, stderr: String(error), signal: null }));
    child.on("close", (status, signal) => resolve({ status, stdout, stderr, signal }));
    child.stdin.end(JSON.stringify({ prompt, cwd: workspace.project, session_id: session }));
  });
}

function historyLines(workspace) {
  const file = path.join(workspace.data, "history", `${localDate()}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function withServer(handler, fn) {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        // leave empty
      }
      handler(request, response, parsed);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function reply(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

test("correction emits context, display, and one history record", async () => {
  const workspace = tempWorkspace();
  let requests = 0;
  try {
    await withServer((request, response, body) => {
      requests += 1;
      assert.equal(body.model, "test-model");
      assert.equal(request.headers.authorization, "Bearer test-token");
      reply(response, 200, {
        type: "message",
        content: [{
          type: "text",
          text: "CORRECTED:\nrefactor the authentication module\nANNOTATIONS:\nautentication → authentication (spelling)",
        }],
        stop_reason: "end_turn",
        model: "test-model",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }, async (port) => {
      const result = await runHook(workspace, "refactor the autentication modul", workspace.env(port));
      assert.equal(result.status, 0, result.stderr);
      const out = JSON.parse(result.stdout);
      assert.match(out.hookSpecificOutput.additionalContext, /Corrected reading/);
      assert.match(out.hookSpecificOutput.additionalContext, /authentication module/);
      assert.match(out.systemMessage, /User intends to say: refactor the authentication module/);
      assert.match(out.systemMessage, /autentication → authentication/);
    });
    assert.equal(requests, 1);
    const records = historyLines(workspace);
    assert.equal(records.length, 1);
    assert.equal(records[0].mode, "correct");
    assert.equal(records[0].original, "refactor the autentication modul");
    assert.equal(records[0].corrected, "refactor the authentication module");
    assert.match(records[0].annotations, /autentication → authentication/);
  } finally {
    workspace.cleanup();
  }
});

test("translation is logged with its source language", async () => {
  const workspace = tempWorkspace();
  try {
    await withServer((request, response) => {
      reply(response, 200, {
        content: [{ type: "text", text: "Fix the error handling in this file.\n(Chinese)" }],
        stop_reason: "end_turn",
      });
    }, async (port) => {
      const result = await runHook(workspace, "把这个文件的错误处理改一下", workspace.env(port));
      assert.equal(result.status, 0);
      const out = JSON.parse(result.stdout);
      assert.match(out.systemMessage, /Translated \(Chinese\)/);
      assert.match(out.hookSpecificOutput.additionalContext, /Fix the error handling/);
    });
    const records = historyLines(workspace);
    assert.equal(records[0].mode, "translate");
    assert.equal(records[0].source_language, "Chinese");
  } finally {
    workspace.cleanup();
  }
});

test("clean prompts produce no output and are logged", async () => {
  const workspace = tempWorkspace();
  try {
    await withServer((request, response) => {
      reply(response, 200, { content: [{ type: "text", text: "CLEAN" }], stop_reason: "end_turn" });
    }, async (port) => {
      const result = await runHook(workspace, "Please review the README and check the examples.", workspace.env(port));
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), "");
    });
    const records = historyLines(workspace);
    assert.equal(records.length, 1);
    assert.equal(records[0].mode, "clean");
  } finally {
    workspace.cleanup();
  }
});

test("auth failure stays fail-open and is visible", async () => {
  const workspace = tempWorkspace();
  try {
    await withServer((request, response) => {
      reply(response, 401, { type: "error", error: { type: "authentication_error", message: "bad key" } });
    }, async (port) => {
      const result = await runHook(workspace, "this sentense have a error", workspace.env(port));
      assert.equal(result.status, 0);
      const out = JSON.parse(result.stdout);
      assert.equal(out.hookSpecificOutput, undefined);
      assert.match(out.systemMessage, /Coaching failed \(auth\)/);
      assert.match(out.systemMessage, /doctor/);
    });
    assert.equal(historyLines(workspace).length, 0);
    const metrics = fs.readFileSync(path.join(workspace.data, "coaching-metrics.jsonl"), "utf8");
    assert.match(metrics, /"failure_code":"auth"/);
  } finally {
    workspace.cleanup();
  }
});

test("commands are skipped, but a configured summary still reaches the model", async () => {
  const workspace = tempWorkspace();
  let requests = 0;
  try {
    fs.writeFileSync(path.join(workspace.project, ".english-buddy.json"), JSON.stringify({ summary_language: "Chinese" }));
    await withServer((request, response) => {
      requests += 1;
      reply(response, 200, { content: [{ type: "text", text: "CLEAN" }], stop_reason: "end_turn" });
    }, async (port) => {
      const result = await runHook(workspace, "/help", workspace.env(port));
      assert.equal(result.status, 0);
      const out = JSON.parse(result.stdout);
      assert.match(out.hookSpecificOutput.additionalContext, /Chinese Summary/);
      assert.equal(out.systemMessage, undefined);
    });
    assert.equal(requests, 0);
  } finally {
    workspace.cleanup();
  }
});

test("no credential is a visible failure and never calls the endpoint", async () => {
  const workspace = tempWorkspace();
  let requests = 0;
  try {
    await withServer((request, response) => {
      requests += 1;
      reply(response, 200, { content: [{ type: "text", text: "CLEAN" }] });
    }, async (port) => {
      const env = workspace.env(port, { ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "", DEEPSEEK_API_KEY: "" });
      const result = await runHook(workspace, "this sentense have a error", env);
      assert.equal(result.status, 0);
      const out = JSON.parse(result.stdout);
      assert.match(out.systemMessage, /no-credentials/);
    });
    assert.equal(requests, 0);
  } finally {
    workspace.cleanup();
  }
});
