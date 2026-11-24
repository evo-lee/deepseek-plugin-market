// Configuration resolution and validation.
//
// Priority: project (.english-buddy.json) > profile global
// ($CLAUDE_CONFIG_DIR/hooks/prompt_coach.json) > legacy global
// (~/.claude/hooks/prompt_coach.json) > defaults.
//
// The legacy global file is read so settings made for the upstream
// english-buddy plugin survive the move to the clds profile.

import path from "node:path";

import {
  globalConfigPath,
  legacyGlobalConfigPath,
  readJsonFile,
  writeJsonFile,
} from "./paths.mjs";

export const CONFIG_NAME = ".english-buddy.json";
export const LEGACY_CONFIG_NAME = ".claude-english-buddy.json";

export const DEFAULTS = Object.freeze({
  coaching_mode: "automatic", // automatic | on-demand
  sample_rate: 1,
  auto_correct: true,
  summary_language: null,
  strictness: "standard", // gentle | standard | strict
  domain_terms: [],
  max_input_chars: 8000,
  escape_prefix: ";;",
  notify_on_failure: true,
  model: null,
  timeout_seconds: null,
  effort: null, // low | high | max | none (Kimi Code only)
});

export const KNOWN_KEYS = [
  "coaching_mode",
  "sample_rate",
  "auto_correct",
  "summary_language",
  "strictness",
  "domain_terms",
  "max_input_chars",
  "escape_prefix",
  "notify_on_failure",
  "model",
  "timeout_seconds",
  "effort",
];

const STRICTNESS = ["gentle", "standard", "strict"];
const COACHING_MODES = ["automatic", "on-demand"];
const EFFORTS = ["low", "high", "max", "none"];

function readLayer(file) {
  const result = readJsonFile(file);
  if (result.missing) return { value: {}, path: file, missing: true, error: null };
  if (result.error || result.value === null || typeof result.value !== "object" || Array.isArray(result.value)) {
    return {
      value: {},
      path: file,
      missing: false,
      error: result.error || new Error("config must be a JSON object"),
    };
  }
  return { value: result.value, path: file, missing: false, error: null };
}

function pickSources(primary, legacy) {
  const sources = {};
  for (const key of Object.keys(legacy.value)) sources[key] = "legacy-global";
  for (const key of Object.keys(primary.value)) sources[key] = "global";
  return sources;
}

function uniqueTerms(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const term of list) {
      if (typeof term !== "string") continue;
      const value = term.trim();
      if (value === "" || seen.has(value.toLowerCase())) continue;
      seen.add(value.toLowerCase());
      out.push(value);
    }
  }
  return out;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function validateConfig(raw) {
  const config = { ...DEFAULTS, ...raw };
  const errors = [];

  if (!COACHING_MODES.includes(config.coaching_mode)) {
    errors.push(`coaching_mode must be one of ${COACHING_MODES.join(", ")}`);
    config.coaching_mode = DEFAULTS.coaching_mode;
  }
  if (!STRICTNESS.includes(config.strictness)) {
    errors.push(`strictness must be one of ${STRICTNESS.join(", ")}`);
    config.strictness = DEFAULTS.strictness;
  }
  if (typeof config.auto_correct !== "boolean") {
    errors.push("auto_correct must be true or false");
    config.auto_correct = DEFAULTS.auto_correct;
  }
  if (typeof config.notify_on_failure !== "boolean") {
    errors.push("notify_on_failure must be true or false");
    config.notify_on_failure = DEFAULTS.notify_on_failure;
  }
  config.sample_rate = clampNumber(config.sample_rate, 0, 1, DEFAULTS.sample_rate);
  config.max_input_chars = Math.round(clampNumber(config.max_input_chars, 100, 200000, DEFAULTS.max_input_chars));
  if (config.timeout_seconds !== null) {
    config.timeout_seconds = clampNumber(config.timeout_seconds, 1, 30, DEFAULTS.timeout_seconds);
    if (config.timeout_seconds === null) errors.push("timeout_seconds must be between 1 and 30");
  }
  if (config.summary_language !== null && typeof config.summary_language !== "string") {
    errors.push("summary_language must be a string or null");
    config.summary_language = null;
  }
  if (config.model !== null && typeof config.model !== "string") {
    errors.push("model must be a string or null");
    config.model = null;
  }
  if (config.effort !== null) {
    if (typeof config.effort !== "string" || !EFFORTS.includes(config.effort.toLowerCase())) {
      errors.push(`effort must be one of ${EFFORTS.join(", ")} or null`);
      config.effort = null;
    } else {
      config.effort = config.effort.toLowerCase();
    }
  }
  if (typeof config.escape_prefix !== "string" || config.escape_prefix === "") {
    errors.push("escape_prefix must be a non-empty string");
    config.escape_prefix = DEFAULTS.escape_prefix;
  }
  config.domain_terms = uniqueTerms(config.domain_terms);
  return { config, errors };
}

export function resolveConfig(cwd = process.cwd(), env = process.env) {
  const primaryPath = globalConfigPath(env);
  const legacyPath = legacyGlobalConfigPath(env);
  const primary = readLayer(primaryPath);
  const legacy = primaryPath === legacyPath ? { value: {}, path: legacyPath, missing: true, error: null } : readLayer(legacyPath);
  const projectCurrent = readLayer(path.join(cwd, CONFIG_NAME));
  const projectLegacy = readLayer(path.join(cwd, LEGACY_CONFIG_NAME));
  const project = projectCurrent.missing && !projectLegacy.missing ? projectLegacy : projectCurrent;

  const global = { ...legacy.value, ...primary.value };
  const merged = { ...DEFAULTS, ...global, ...project.value };
  merged.domain_terms = uniqueTerms(legacy.value.domain_terms, primary.value.domain_terms, project.value.domain_terms);

  const { config, errors } = validateConfig(merged);
  const sources = pickSources(primary, legacy);
  for (const key of Object.keys(project.value)) sources[key] = "project";
  for (const key of Object.keys(DEFAULTS)) sources[key] ??= "default";

  return {
    config,
    sources,
    paths: {
      global: primaryPath,
      legacyGlobal: legacyPath,
      project: project.path,
      projectLegacy: projectLegacy.path,
    },
    layers: { primary, legacy, project },
    errors: [
      ...errors,
      ...[primary, legacy, project].filter((layer) => layer.error).map((layer) => `${layer.path}: ${layer.error.message}`),
    ],
  };
}

export function parseValue(key, raw) {
  if (!KNOWN_KEYS.includes(key)) return { error: `unknown setting ${key}; known: ${KNOWN_KEYS.join(", ")}` };
  switch (key) {
    case "auto_correct":
    case "notify_on_failure":
      if (raw === "true") return { value: true };
      if (raw === "false") return { value: false };
      return { error: `${key} must be true or false` };
    case "sample_rate": {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 1) return { error: "sample_rate must be a number from 0 to 1" };
      return { value };
    }
    case "timeout_seconds": {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 1 || value > 30) return { error: "timeout_seconds must be a number from 1 to 30" };
      return { value };
    }
    case "max_input_chars": {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 100 || value > 200000) {
        return { error: "max_input_chars must be an integer from 100 to 200000" };
      }
      return { value };
    }
    case "strictness":
      if (!STRICTNESS.includes(raw)) return { error: `strictness must be one of ${STRICTNESS.join(", ")}` };
      return { value: raw };
    case "coaching_mode":
      if (!COACHING_MODES.includes(raw)) return { error: `coaching_mode must be one of ${COACHING_MODES.join(", ")}` };
      return { value: raw };
    case "summary_language":
      return { value: raw === "" || raw === "disabled" || raw === "null" ? null : raw };
    case "domain_terms":
      return { value: raw.split(",").map((term) => term.trim()).filter(Boolean) };
    case "model":
      return { value: raw.trim() === "" ? null : raw.trim() };
    case "effort": {
      const value = raw.trim().toLowerCase();
      if (value === "" || value === "null" || value === "disabled" || value === "none") return { value: null };
      if (!EFFORTS.includes(value)) return { error: `effort must be one of ${EFFORTS.join(", ")}` };
      return { value };
    }
    case "escape_prefix":
      if (raw === "") return { error: "escape_prefix must not be empty" };
      return { value: raw };
    default:
      return { error: `unknown setting ${key}` };
  }
}

export function saveSetting({ cwd = process.cwd(), env = process.env, scope = "project", key, value }) {
  if (!KNOWN_KEYS.includes(key)) return { ok: false, error: `unknown setting ${key}` };
  const file = scope === "global" ? globalConfigPath(env) : path.join(cwd, CONFIG_NAME);
  const loaded = readLayer(file);
  if (loaded.error) return { ok: false, error: `${file}: ${loaded.error.message}`, path: file };

  const next = { ...loaded.value };
  if (value === undefined) delete next[key];
  else next[key] = value;
  try {
    writeJsonFile(file, next);
  } catch (error) {
    return { ok: false, error: error.message, path: file };
  }
  return { ok: true, path: file, config: next };
}

export function formatConfigTable(resolved) {
  const { config, sources, paths } = resolved;
  const value = (key) => {
    const raw = config[key];
    if (raw === null || raw === undefined) {
      return key === "timeout_seconds" || key === "model" || key === "effort" ? "provider default" : "disabled";
    }
    if (Array.isArray(raw)) return raw.length === 0 ? "none" : raw.join(", ");
    return String(raw);
  };
  const rows = [
    ["coaching_mode", value("coaching_mode"), sources.coaching_mode],
    ["auto_correct", value("auto_correct"), sources.auto_correct],
    ["strictness", value("strictness"), sources.strictness],
    ["sample_rate", value("sample_rate"), sources.sample_rate],
    ["timeout_seconds", value("timeout_seconds"), sources.timeout_seconds],
    ["effort", value("effort"), sources.effort],
    ["max_input_chars", value("max_input_chars"), sources.max_input_chars],
    ["summary_language", value("summary_language"), sources.summary_language],
    ["domain_terms", value("domain_terms"), sources.domain_terms],
    ["escape_prefix", value("escape_prefix"), sources.escape_prefix],
    ["notify_on_failure", value("notify_on_failure"), sources.notify_on_failure],
    ["model", value("model"), sources.model],
  ];
  const lines = [
    "# English Coach Config",
    "",
    "## Active Settings (merged)",
    "",
    "| Setting | Value | Source |",
    "|---------|-------|--------|",
    ...rows.map(([key, val, source]) => `| \`${key}\` | ${escapeCell(val)} | ${source} |`),
    "",
    "## Files",
    "",
    `- Global: \`${paths.global}\``,
    `- Legacy global (read-only fallback): \`${paths.legacyGlobal}\``,
    `- Project: \`${paths.project}\``,
    "- Priority: project > global > legacy global > defaults",
    "- `domain_terms` merge from all three layers.",
  ];
  if (resolved.errors.length > 0) {
    lines.push("", "## Configuration Warnings", "", ...resolved.errors.map((error) => `- ${error}`));
  }
  return `${lines.join("\n")}\n`;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
