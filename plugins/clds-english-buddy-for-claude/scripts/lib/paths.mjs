// Path resolution that works in both a normal Claude Code profile and the
// isolated clds profile (CLAUDE_CONFIG_DIR=~/.claude-deepseek).
//
// Claude Code gives plugin hooks a CLAUDE_PLUGIN_DATA directory. Slash commands
// run in a Bash tool where that variable is not always present, so reports must
// be able to find the same directory from the profile's plugins/data folder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PLUGIN_NAME = "clds-english-buddy-for-claude";

// Histories written by the upstream english-buddy plugin still describe the
// same user, so they are reported as a fallback when this plugin has no data
// directory of its own yet.
const LEGACY_PREFIXES = ["english-buddy-", "claude-english-buddy-", "clds-english-buddy-"];

function homeOf(env) {
  return env.HOME || os.homedir();
}

export function configHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(homeOf(env), ".claude");
}

export function globalConfigPath(env = process.env) {
  return path.join(configHome(env), "hooks", "prompt_coach.json");
}

export function legacyGlobalConfigPath(env = process.env) {
  return path.join(homeOf(env), ".claude", "hooks", "prompt_coach.json");
}

export function deepseekKeyFile(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(homeOf(env), ".config");
  return path.join(base, "claude-driven-ai-providers", "deepseek-api-key");
}

function dataRoots(env) {
  const roots = [];
  const push = (root) => {
    if (root && !roots.includes(root)) roots.push(root);
  };
  if (env.CLAUDE_CONFIG_DIR) push(path.join(env.CLAUDE_CONFIG_DIR, "plugins", "data"));
  push(path.join(homeOf(env), ".claude", "plugins", "data"));
  push(path.join(homeOf(env), ".claude-deepseek", "plugins", "data"));
  return roots;
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function rank(name) {
  if (name === PLUGIN_NAME) return 0;
  if (name.startsWith(`${PLUGIN_NAME}-`)) return 1;
  if (LEGACY_PREFIXES.some((prefix) => name.startsWith(prefix))) return 2;
  return 3;
}

/**
 * Find an existing plugin data directory.
 *
 * Priority: explicit override, CLDS_ENGLISH_BUDDY_DATA_DIR, CLAUDE_PLUGIN_DATA,
 * then a directory created for this plugin under a Claude profile. When this
 * plugin has never written anything, an upstream english-buddy directory is
 * accepted so existing history keeps working.
 */
export function resolveDataDir({ env = process.env, explicit = null, create = true } = {}) {
  if (explicit) return path.resolve(explicit);
  if (env.CLDS_ENGLISH_BUDDY_DATA_DIR) return path.resolve(env.CLDS_ENGLISH_BUDDY_DATA_DIR);
  if (env.CLAUDE_PLUGIN_DATA) return path.resolve(env.CLAUDE_PLUGIN_DATA);

  const candidates = [];
  for (const root of dataRoots(env)) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (rank(entry.name) > 2) continue;
      const dir = path.join(root, entry.name);
      candidates.push({ dir, rank: rank(entry.name), mtime: mtimeOf(dir) });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank || b.mtime - a.mtime);
  if (candidates.length > 0) return candidates[0].dir;

  const primary = path.join(configHome(env), "plugins", "data", PLUGIN_NAME);
  if (create) fs.mkdirSync(primary, { recursive: true });
  return primary;
}

export function dataRootFor(dir) {
  return path.dirname(dir);
}

export function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return { value: JSON.parse(text), error: null };
  } catch (error) {
    if (error && error.code === "ENOENT") return { value: null, error: null, missing: true };
    return { value: null, error };
  }
}

export function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return file;
}
