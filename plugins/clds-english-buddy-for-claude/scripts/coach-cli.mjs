#!/usr/bin/env node
// Dry-run coaching and single-pass review for slash commands.
//
// Nothing here writes history. The command layer uses this so a DeepSeek model
// never has to re-implement the correction pipeline or parse JSONL.

import fs from "node:fs";
import process from "node:process";

import { formatAnnotationsForDisplay } from "./lib/annotations.mjs";
import {
  buildCorrectSystem,
  buildRefineSystem,
  buildReviewSystem,
  buildReviewUser,
  buildTranslateSystem,
  evaluateOutput,
} from "./lib/coach.mjs";
import { resolveConfig } from "./lib/config.mjs";
import { detectMode } from "./lib/detect.mjs";
import { callMessages, resolveProvider, sanitizeMessage } from "./lib/provider.mjs";

function parseArgs(argv) {
  const options = { command: argv[0] || null, text: "", file: null, maxChars: 50000, json: false, forceText: false };
  const rest = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      options.file = argv[++index];
      if (!options.file) throw new Error("--file needs a path");
    } else if (arg === "--text") {
      options.forceText = true;
    } else if (arg === "--max-chars") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 100) throw new Error("--max-chars must be an integer >= 100");
      options.maxChars = value;
    } else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else rest.push(arg);
  }
  options.text = rest.join(" ");
  return options;
}

function help() {
  process.stdout.write(`Usage:
  node coach-cli.mjs preview [text] [--file path] [--text] [--max-chars N]
  node coach-cli.mjs review  [text] [--file path] [--text] [--max-chars N]

When no text/file is given, stdin is read (use a heredoc from a slash command).
A bare existing file path is read as a file; --text forces inline text.
Preview never writes history.
`);
}

function readInput(options) {
  let text = options.text;
  if (options.file) {
    if (!fs.existsSync(options.file)) throw new Error(`File not found: ${options.file}`);
    text = fs.readFileSync(options.file, "utf8");
  } else if (text === "" && !process.stdin.isTTY) {
    text = fs.readFileSync(0, "utf8");
  } else if (!options.forceText && text !== "" && !text.includes("\n") && !/\s/.test(text) && fs.existsSync(text) && fs.statSync(text).isFile()) {
    // A bare existing path is a file reference, matching the upstream command.
    text = fs.readFileSync(text, "utf8");
  }
  text = text.replace(/\r\n/g, "\n").trim();
  if (text.length > options.maxChars) {
    throw new Error(`Input is ${text.length} characters; the limit is ${options.maxChars} (use --max-chars).`);
  }
  return text;
}

function failureText(failure) {
  return [
    `# English Buddy — request failed`,
    "",
    `**${failure.failureCode || "error"}**: ${sanitizeMessage(failure.message)}`,
    "",
    "The original text was not changed. Run `/clds-english-buddy-for-claude:doctor` to inspect the route.",
  ].join("\n");
}

function previewMarkdown(original, mode, evaluation) {
  const lines = [
    "# Preview — Dry Run",
    "",
    `**Mode**: ${mode}`,
    "**No history was written and nothing was submitted.**",
    "",
    "## Original",
    "",
    "> " + original.replace(/\n/g, "\n> "),
    "",
  ];

  if (evaluation.kind === "clean") {
    lines.push("## Verdict", "", "No corrections. Ready to submit.");
    return `${lines.join("\n")}\n`;
  }
  if (evaluation.kind === "error" || evaluation.kind === "rejected") {
    lines.push("## Verdict", "", `No change suggested (${evaluation.failureCode || "rejected"}): ${sanitizeMessage(evaluation.message)}`);
    return `${lines.join("\n")}\n`;
  }

  const corrected = evaluation.kind === "translation" ? evaluation.translated : evaluation.corrected;
  lines.push("## Corrected Reading", "", corrected, "");
  if (evaluation.kind === "translation") {
    lines.push(`Detected source language: ${evaluation.sourceLanguage || "unknown"}`, "");
  }
  if (evaluation.annotations && evaluation.annotations.length > 0) {
    lines.push("## What Changed", "", formatAnnotationsForDisplay(evaluation.annotations), "");
  } else if (evaluation.kind === "correction") {
    lines.push("## What Changed", "", "No annotation pairs were returned; the corrected reading differs from the original.", "");
  }
  lines.push("## Verdict", "", "Consider using the corrected reading before submitting.");
  return `${lines.join("\n")}\n`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`coach: ${error.message}\n`);
    help();
    process.exit(2);
  }
  if (options.help || !["preview", "review"].includes(options.command)) {
    help();
    process.exit(options.command ? 2 : 0);
  }

  let input;
  try {
    input = readInput(options);
  } catch (error) {
    process.stderr.write(`coach: ${error.message}\n`);
    process.exit(2);
  }
  if (!input) {
    process.stderr.write("coach: no text supplied. Pass text, --file, or stdin.\n");
    process.exit(2);
  }

  const resolved = resolveConfig(process.cwd());
  const provider = resolveProvider({ config: resolved.config });
  if (!provider.ok) {
    const failure = { failureCode: provider.failureCode, message: provider.message };
    process.stdout.write(`${options.json ? JSON.stringify({ ok: false, ...failure }) : failureText(failure)}\n`);
    process.exit(1);
  }

  if (options.command === "review") {
    const result = await callMessages(provider, {
      system: buildReviewSystem(resolved.config),
      user: buildReviewUser(input),
      maxTokens: 4000,
    });
    if (!result.ok) {
      process.stdout.write(`${options.json ? JSON.stringify(result) : failureText(result)}\n`);
      process.exit(1);
    }
    process.stdout.write(result.text.trim() + "\n");
    return;
  }

  const detection = detectMode(input, {
    escapePrefix: resolved.config.escape_prefix,
    maxInputChars: resolved.config.max_input_chars,
  });
  if (detection.mode === "skip") {
    process.stdout.write("# Preview — Dry Run\n\nThis input is not prose the coach handles (command, URL, code, or too short). Nothing to preview.\n");
    return;
  }
  if (detection.mode === "escape") {
    process.stdout.write("# Preview — Dry Run\n\nThis input starts with the escape prefix; automatic coaching would skip it.\n");
    return;
  }
  if (detection.mode === "refine" && detection.text.trim() === "") {
    process.stdout.write("# Preview — Dry Run\n\nNothing to refine. Put text after `::`.\n");
    return;
  }

  const system = detection.mode === "translate"
    ? buildTranslateSystem(resolved.config)
    : detection.mode === "refine"
      ? buildRefineSystem(resolved.config)
      : buildCorrectSystem(resolved.config);

  const result = await callMessages(provider, {
    system,
    user: detection.text,
    maxTokens: detection.mode === "refine" ? 1600 : 1024,
  });
  if (!result.ok) {
    process.stdout.write(`${options.json ? JSON.stringify(result) : failureText(result)}\n`);
    process.exit(1);
  }

  const evaluation = evaluateOutput(detection.mode, result.text, detection.text, resolved.config);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, mode: detection.mode, original: detection.text, evaluation }, null, 2)}\n`);
    return;
  }
  process.stdout.write(previewMarkdown(detection.text, detection.mode, evaluation));
}

main();
