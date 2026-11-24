#!/usr/bin/env node
// Read or update coaching configuration without asking the model to splice
// JSON. The model can display this output, but the write is deterministic.

import process from "node:process";

import {
  formatConfigTable,
  parseValue,
  resolveConfig,
  saveSetting,
} from "./lib/config.mjs";

function parseArgs(argv) {
  const options = { show: false, scope: "project", sets: [], unsets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--show") options.show = true;
    else if (arg === "--global") options.scope = "global";
    else if (arg === "--project") options.scope = "project";
    else if (arg === "--set") {
      const next = argv[++index];
      if (next === undefined) throw new Error("--set needs key=value");
      const equals = next.indexOf("=");
      if (equals === -1) throw new Error("--set needs key=value");
      options.sets.push({ key: next.slice(0, equals), raw: next.slice(equals + 1) });
    } else if (arg === "--unset") {
      const next = argv[++index];
      if (next === undefined) throw new Error("--unset needs a key");
      options.unsets.push(next);
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return options;
}

function help() {
  process.stdout.write(`Usage: node config-cli.mjs [--show] [--global|--project] [--set key=value] [--unset key]

Settings: auto_correct, summary_language, strictness, coaching_mode, sample_rate,
          timeout_seconds, max_input_chars, domain_terms, escape_prefix,
          notify_on_failure, model
`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`config: ${error.message}\n`);
    help();
    process.exit(2);
  }
  if (options.help) {
    help();
    return;
  }

  const cwd = process.cwd();
  for (const { key, raw } of options.sets) {
    const parsed = parseValue(key, raw);
    if (parsed.error) {
      process.stderr.write(`config: ${parsed.error}\n`);
      process.exit(2);
    }
    const result = saveSetting({ cwd, scope: options.scope, key, value: parsed.value });
    if (!result.ok) {
      process.stderr.write(`config: ${result.error}\n`);
      process.exit(1);
    }
    process.stdout.write(`Set \`${key}\` = ${JSON.stringify(parsed.value)} in \`${result.path}\`.\n`);
  }
  for (const key of options.unsets) {
    const result = saveSetting({ cwd, scope: options.scope, key, value: undefined });
    if (!result.ok) {
      process.stderr.write(`config: ${result.error}\n`);
      process.exit(1);
    }
    process.stdout.write(`Unset \`${key}\` in \`${result.path}\`.\n`);
  }
  if (options.sets.length > 0 || options.unsets.length > 0) process.stdout.write("\n");

  const resolved = resolveConfig(cwd);
  process.stdout.write(formatConfigTable(resolved));
}

main();
