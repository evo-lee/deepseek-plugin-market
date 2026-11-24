#!/usr/bin/env node
// UserPromptSubmit hook: correct English, translate non-English, or refine a
// :: prompt, then add the corrected reading to Claude's context and show the
// user what changed.
//
// Claude Code has no hook output that replaces the submitted prompt, so the
// model sees the typed text and the corrected reading. The additionalContext
// tells it to act on the corrected reading while preserving literals. This is
// the honest version of the upstream README's "Claude sees the corrected
// version" claim.
//
// Fail-open: any failure leaves the prompt untouched and exits 0. Failures are
// visible through systemMessage, the metrics file, and the doctor command.

import fs from "node:fs";
import process from "node:process";

import {
  formatAnnotationsForDisplay,
  formatAnnotationsForStorage,
} from "./lib/annotations.mjs";
import {
  buildCorrectSystem,
  buildRefineSystem,
  buildSummaryContext,
  buildTranslateSystem,
  evaluateOutput,
} from "./lib/coach.mjs";
import { resolveConfig } from "./lib/config.mjs";
import { detectMode, sampleAllows } from "./lib/detect.mjs";
import { callMessages, resolveProvider, sanitizeMessage } from "./lib/provider.mjs";
import { logClean, logCorrection, logMetric } from "./lib/state.mjs";

const DOCTOR = "/clds-english-buddy-for-claude:doctor";

function readStdin() {
  try {
    const text = fs.readFileSync(0, "utf8").trim();
    return text === "" ? {} : JSON.parse(text);
  } catch {
    return {};
  }
}

function emit({ additionalContext, systemMessage, decision, reason }) {
  const output = {};
  if (additionalContext) {
    output.hookSpecificOutput = {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    };
  }
  if (systemMessage) output.systemMessage = systemMessage;
  if (decision) {
    output.decision = decision;
    output.reason = reason || "";
  }
  if (Object.keys(output).length > 0) process.stdout.write(`${JSON.stringify(output)}\n`);
}

function withSummary(context, summary) {
  if (!summary) return context;
  return context ? `${context}\n\n${summary}` : summary;
}

function correctedContext(corrected) {
  return `[english-buddy] The user's message may contain language errors. Corrected reading of their intent:
"""
${corrected}
"""
When the corrected reading differs from the typed message, act on the corrected reading. Preserve every literal (code, paths, identifiers, commands, numbers) exactly as typed. This note is coaching for the user; do not mention it unless asked.`;
}

function translatedContext(translated, sourceLanguage) {
  return `[english-buddy] The user wrote in ${sourceLanguage || "a non-English language"}. Their message in English:
"""
${translated}
"""
Act on this translation as the user's request. Preserve every literal (code, paths, identifiers, commands, numbers) exactly as typed. This note is coaching for the user; do not mention it unless asked.`;
}

function refinedContext(refined) {
  return `[english-buddy] The user prefixed the message with :: to request a refined prompt. Use this refined version as their request:
"""
${refined}
"""
Preserve every named file, command, constraint, and number from the original. This note is coaching for the user; do not mention it unless asked.`;
}

function escapeContext(text, prefix) {
  return `[english-buddy] The message starts with the escape prefix ${JSON.stringify(prefix)}. Treat everything after that prefix as the prompt verbatim; do not correct, translate, or refine it.`;
}

function failureNotice(failure) {
  const code = failure.failureCode || "error";
  return `[english-buddy] Coaching failed (${code}): ${sanitizeMessage(failure.message)} Original prompt unchanged. Run ${DOCTOR}.`;
}

function writeOutput(text) {
  try {
    process.stdout.write(text);
  } catch {
    // The host closed the pipe; there is no one left to tell.
  }
}

function metric(entry) {
  logMetric(entry);
}

async function run() {
  const input = readStdin();
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (prompt.trim() === "") return;

  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
  const session = input.session_id || process.env.CLAUDE_SESSION_ID || null;
  const started = Date.now();
  const resolved = resolveConfig(cwd);
  const config = resolved.config;
  const summary = buildSummaryContext(config.summary_language);

  const detection = detectMode(prompt, {
    escapePrefix: config.escape_prefix,
    maxInputChars: config.max_input_chars,
  });

  if (detection.mode === "skip") {
    emit({ additionalContext: withSummary("", summary) });
    return;
  }

  if (detection.mode === "escape") {
    emit({
      additionalContext: withSummary(escapeContext(detection.text, config.escape_prefix), summary),
    });
    return;
  }

  const explicit = detection.mode === "refine";
  if (!explicit && config.coaching_mode === "on-demand") {
    emit({ additionalContext: withSummary("", summary) });
    return;
  }
  if (!explicit && !sampleAllows(prompt, config.sample_rate)) {
    emit({ additionalContext: withSummary("", summary) });
    return;
  }
  if (!explicit && !config.auto_correct) {
    emit({ additionalContext: withSummary("", summary) });
    return;
  }

  if (explicit && detection.text.trim() === "") {
    writeOutput(JSON.stringify({ decision: "block", reason: "Nothing to refine. Put text after ::." }) + "\n");
    return;
  }
  if (explicit && [...detection.text].length > config.max_input_chars) {
    emit({ additionalContext: withSummary("", summary) });
    return;
  }

  const provider = resolveProvider({ config });
  if (!provider.ok) {
    if (config.notify_on_failure) emit({ systemMessage: failureNotice(provider) });
    metric({
      mode: detection.mode,
      outcome: "failure",
      failure_code: provider.failureCode,
      provider_family: provider.family,
      model: provider.model,
      elapsed_ms: Date.now() - started,
      session,
    });
    return;
  }

  const system = detection.mode === "translate"
    ? buildTranslateSystem(config)
    : detection.mode === "refine"
      ? buildRefineSystem(config)
      : buildCorrectSystem(config);

  const result = await callMessages(provider, {
    system,
    user: detection.text,
    maxTokens: detection.mode === "refine" ? 1600 : 1024,
  });

  if (!result.ok) {
    if (config.notify_on_failure) emit({ systemMessage: failureNotice(result) });
    metric({
      mode: detection.mode,
      outcome: "failure",
      failure_code: result.failureCode,
      provider_family: provider.family,
      model: provider.model,
      elapsed_ms: Date.now() - started,
      session,
    });
    return;
  }

  const evaluation = evaluateOutput(detection.mode, result.text, detection.text, config);
  const usage = {
    provider_family: provider.family,
    model: result.model || provider.model,
    input_tokens: result.usage?.input_tokens ?? null,
    output_tokens: result.usage?.output_tokens ?? null,
    elapsed_ms: Date.now() - started,
    session,
  };

  if (evaluation.kind === "clean") {
    logClean({ provider: provider.family, model: result.model || provider.model, session }, {});
    metric({ mode: detection.mode, outcome: "clean", failure_code: null, ...usage });
    emit({ additionalContext: withSummary("", summary) });
    return;
  }

  if (evaluation.kind === "rejected" || evaluation.kind === "error") {
    if (config.notify_on_failure) {
      emit({
        systemMessage: `[english-buddy] ${evaluation.failureCode || "coaching-error"}: ${sanitizeMessage(evaluation.message)} Original prompt unchanged. Run ${DOCTOR}.`,
      });
    }
    metric({ mode: detection.mode, outcome: "failure", failure_code: evaluation.failureCode || "coaching-error", ...usage });
    return;
  }

  let context;
  let display;
  let stored;
  if (evaluation.kind === "translation") {
    context = translatedContext(evaluation.translated, evaluation.sourceLanguage);
    display = evaluation.sourceLanguage
      ? `Translated (${evaluation.sourceLanguage}): ${evaluation.translated}`
      : `Translated: ${evaluation.translated}`;
    stored = {
      mode: "translate",
      original: detection.text,
      corrected: evaluation.translated,
      annotations: evaluation.sourceLanguage || null,
      sourceLanguage: evaluation.sourceLanguage,
    };
  } else if (evaluation.kind === "refinement") {
    context = refinedContext(evaluation.corrected);
    display = `Refined: ${evaluation.corrected}`;
    stored = {
      mode: "refine",
      original: detection.text,
      corrected: evaluation.corrected,
      annotations: null,
    };
  } else {
    context = correctedContext(evaluation.corrected);
    const annotations = evaluation.annotations || [];
    display = `User intends to say: ${evaluation.corrected}`;
    if (annotations.length > 0) display += `\n${formatAnnotationsForDisplay(annotations)}`;
    stored = {
      mode: "correct",
      original: detection.text,
      corrected: evaluation.corrected,
      annotations: annotations.length > 0 ? formatAnnotationsForStorage(annotations) : null,
    };
  }

  const logged = logCorrection(
    {
      ...stored,
      provider: provider.family,
      model: result.model || provider.model,
      session,
    },
    {},
  );
  metric({
    mode: detection.mode,
    outcome: evaluation.kind,
    failure_code: null,
    annotation_count: stored.annotations ? String(stored.annotations).split("\n").filter(Boolean).length : 0,
    ...usage,
  });

  let message = display;
  if (!logged.ok) {
    message += `\n[english-buddy] Could not write coaching history: ${sanitizeMessage(logged.error?.message)}. Run ${DOCTOR}.`;
  }
  emit({ additionalContext: withSummary(context, summary), systemMessage: message });
}

run().catch((error) => {
  // A listener failure must never block the prompt.
  try {
    writeOutput(JSON.stringify({
      systemMessage: `[english-buddy] listener-error: ${sanitizeMessage(error?.message)} Original prompt unchanged. Run ${DOCTOR}.`,
    }) + "\n");
  } catch {
    // ignore
  }
});
