#!/usr/bin/env node
// Diagnostics for the coaching path. Never prints a credential.

import fs from "node:fs";
import os from "node:os";
import process from "node:process";

import { resolveConfig } from "./lib/config.mjs";
import { deepseekKeyFile, globalConfigPath } from "./lib/paths.mjs";
import { callMessages, describeProvider, resolveProvider, sanitizeMessage } from "./lib/provider.mjs";
import { historySummary, readMetrics } from "./lib/state.mjs";

function parseArgs(argv) {
  const options = { probe: false, json: false, dataDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--probe") options.probe = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--data-dir") {
      const value = argv[++index];
      if (!value) throw new Error("--data-dir needs a path");
      options.dataDir = value;
    } else if (arg.startsWith("--data-dir=")) options.dataDir = arg.slice("--data-dir=".length);
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return options;
}

function help() {
  process.stdout.write(`Usage: node doctor.mjs [--probe] [--json] [--data-dir DIR]

Checks the active clai coaching route (clds/DeepSeek, clkc/Kimi Code, ...)
without printing credentials.
--probe makes one small live request (it can incur API charges).
`);
}

function keyFileStatus(env) {
  const file = deepseekKeyFile(env);
  try {
    const stat = fs.statSync(file);
    const mode = (stat.mode & 0o777).toString(8);
    return { exists: true, path: file, mode };
  } catch {
    return { exists: false, path: file, mode: null };
  }
}

function lastFailure(metrics) {
  for (let index = metrics.length - 1; index >= 0; index -= 1) {
    const entry = metrics[index];
    if (entry.failure_code || entry.failure) return entry;
  }
  return null;
}

function buildReport({ provider, resolved, history, metrics, env }) {
  const description = describeProvider(provider);
  const keyFile = keyFileStatus(env);
  const failure = lastFailure(metrics);
  const warnings = [];

  if (!provider.ok) warnings.push(provider.message || `Provider is not usable (${provider.failureCode}).`);
  if (provider.hasToken && /keychain/i.test(provider.credentialSource) && provider.family !== "anthropic") {
    warnings.push("A keychain credential was selected for a non-Anthropic endpoint. Refusing to send it is the safe behavior; this build should not do that.");
  }
  if (provider.family === "deepseek" && !provider.hasToken && keyFile.exists) {
    warnings.push(`The DeepSeek key file exists (${keyFile.path}) but was not readable; check its permissions.`);
  }
  if (history.todayRecords === 0) {
    warnings.push("No records today. If you have submitted prompts, the hook is not running in this session; restart the clai launcher after enabling the plugin.");
  }
  if (failure) {
    warnings.push(`Last coaching failure: ${failure.failure_code || failure.failure || "unknown"} at ${failure.ts}${failure.message ? ` — ${sanitizeMessage(failure.message)}` : ""}`);
  }
  if (!env.CLAUDE_CONFIG_DIR) {
    warnings.push("CLAUDE_CONFIG_DIR is unset; clai launchers normally set it to ~/.claude-<provider>.");
  } else if (!/\.claude-[A-Za-z0-9._-]+/.test(env.CLAUDE_CONFIG_DIR)) {
    warnings.push(`CLAUDE_CONFIG_DIR is ${env.CLAUDE_CONFIG_DIR}; this does not look like a clai provider profile.`);
  }
  if ((provider.family === "kimi" || provider.family === "kimi-code")
    && resolved.config.coaching_mode === "automatic"
    && Number(resolved.config.sample_rate) >= 1) {
    warnings.push("Kimi K3/K3.1 Pro require thinking, so each coaching call can take several seconds even at effort=low. Consider coaching_mode=on-demand or a lower sample_rate.");
  }
  if (provider.family === "compatible") {
    warnings.push("The endpoint is not recognized as DeepSeek, Anthropic, or Kimi. The plugin will still use the Anthropic Messages shape, but thinking and effort are left to the provider.");
  }

  return {
    ok: provider.ok,
    node: process.version,
    platform: `${process.platform} ${os.release()}`,
    configDir: env.CLAUDE_CONFIG_DIR || null,
    globalConfig: globalConfigPath(env),
    projectConfig: resolved.paths.project,
    provider: description,
    keyFile,
    history,
    lastFailure: failure ? { ts: failure.ts, code: failure.failure_code || failure.failure || null, message: failure.message || null } : null,
    warnings,
    settings: resolved.config,
    settingsErrors: resolved.errors,
  };
}

function markdown(report, probe) {
  const p = report.provider;
  const lines = [
    "# English Buddy Doctor",
    "",
    "| Check | Value |",
    "|-------|-------|",
    `| Node | ${report.node} |`,
    `| Platform | ${report.platform} |`,
    `| CLAUDE_CONFIG_DIR | ${report.configDir || "unset"} |`,
    `| Provider family | ${p.family} |`,
    `| Base URL | ${p.baseUrl} |`,
    `| Messages endpoint | ${p.endpoint} |`,
    `| Base URL source | ${p.baseSource} |`,
    `| Model | ${p.model || "(none)"} |`,
    `| Model source | ${p.modelSource} |`,
    `| Thinking | ${p.thinking} |`,
    `| Effort | ${p.effort}${p.effortSource && p.effortSource !== "unsupported" ? ` (${p.effortSource})` : ""} |`,
    `| Max output tokens | ${p.maxTokens ?? "request default"} |`,
    `| Timeout | ${p.timeoutSeconds}s (${p.timeoutSource}) |`,
    `| Credential source | ${p.credentialSource} |`,
    `| Auth scheme | ${p.authScheme} |`,
    `| Token present | ${p.hasToken ? "yes" : "no"} |`,
    `| DeepSeek key file | ${report.provider.family === "deepseek" ? (report.keyFile.exists ? `${report.keyFile.path} (mode ${report.keyFile.mode})` : "not present") : "not used for this provider"} |`,
    `| Data directory | ${report.history.dataDir} |`,
    `| History days | ${report.history.days} |`,
    `| Records today | ${report.history.todayRecords} |`,
    `| Global config | ${report.globalConfig} |`,
    `| Project config | ${report.projectConfig} |`,
    "",
  ];

  if (probe) {
    lines.push("## Live Probe", "");
    if (probe.ok) {
      lines.push(`PASS — HTTP ${probe.status}, ${probe.latencyMs} ms, model \`${probe.model}\`, stop reason \`${probe.stopReason || "unknown"}\`.`);
      lines.push("", `> ${sanitizeMessage(probe.text).slice(0, 160)}`);
    } else {
      lines.push(`FAIL — ${probe.failureCode}: ${sanitizeMessage(probe.message)}`);
    }
    lines.push("");
  } else {
    lines.push("Run `--probe` to make one small live request and verify generation.", "");
  }

  if (report.warnings.length > 0) {
    lines.push("## Warnings", "", ...report.warnings.map((warning) => `- ${warning}`), "");
  } else {
    lines.push("## Warnings", "", "None.", "");
  }
  if (report.settingsErrors.length > 0) {
    lines.push("## Config Errors", "", ...report.settingsErrors.map((error) => `- ${error}`), "");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`doctor: ${error.message}\n`);
    help();
    process.exit(2);
  }
  if (options.help) {
    help();
    return;
  }

  const resolved = resolveConfig(process.cwd());
  const provider = resolveProvider({ config: resolved.config });
  const dataOptions = { explicit: options.dataDir };
  const history = historySummary(dataOptions);
  const metrics = readMetrics(dataOptions);
  const report = buildReport({ provider, resolved, history, metrics, env: process.env });

  let probe = null;
  if (options.probe) {
    probe = await callMessages(provider, {
      system: "You are a connectivity check for a language-coaching hook. Reply with exactly one word: OK",
      user: "Reply with OK.",
      maxTokens: 16,
    });
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...report, probe }, null, 2)}\n`);
  } else {
    process.stdout.write(markdown(report, probe));
  }

  const failed = !provider.ok || (probe && !probe.ok);
  process.exit(failed ? 1 : 0);
}

main();
