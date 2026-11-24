import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatConfigTable,
  parseValue,
  resolveConfig,
  saveSetting,
} from "../scripts/lib/config.mjs";

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceb-config-"));
  const project = path.join(dir, "project");
  fs.mkdirSync(project, { recursive: true });
  return {
    dir,
    project,
    env: {
      HOME: path.join(dir, "home"),
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      XDG_CONFIG_HOME: path.join(dir, "xdg"),
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("project config overrides global and domain terms merge", () => {
  const h = tempProject();
  try {
    const globalFile = path.join(h.dir, "claude", "hooks", "prompt_coach.json");
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });
    fs.writeFileSync(globalFile, JSON.stringify({
      strictness: "gentle",
      summary_language: "Chinese",
      domain_terms: ["Tailscale"],
    }));
    fs.writeFileSync(path.join(h.project, ".english-buddy.json"), JSON.stringify({
      strictness: "strict",
      domain_terms: ["Headscale", "tailscale"],
    }));

    const resolved = resolveConfig(h.project, h.env);
    assert.equal(resolved.config.strictness, "strict");
    assert.equal(resolved.sources.strictness, "project");
    assert.equal(resolved.config.summary_language, "Chinese");
    assert.equal(resolved.sources.summary_language, "global");
    assert.deepEqual(resolved.config.domain_terms, ["Tailscale", "Headscale"]);
    assert.match(formatConfigTable(resolved), /strict \| project/);
  } finally {
    h.cleanup();
  }
});

test("legacy global config is read as a fallback", () => {
  const h = tempProject();
  try {
    const legacy = path.join(h.env.HOME, ".claude", "hooks", "prompt_coach.json");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ auto_correct: false }));
    const resolved = resolveConfig(h.project, h.env);
    assert.equal(resolved.config.auto_correct, false);
    assert.equal(resolved.sources.auto_correct, "legacy-global");
  } finally {
    h.cleanup();
  }
});

test("values are validated before writing", () => {
  assert.equal(parseValue("strictness", "strict").value, "strict");
  assert.match(parseValue("strictness", "sloppy").error, /strictness/);
  assert.equal(parseValue("auto_correct", "false").value, false);
  assert.match(parseValue("sample_rate", "2").error, /0 to 1/);
  assert.deepEqual(parseValue("domain_terms", "A, B, a").value, ["A", "B", "a"]);
  assert.equal(parseValue("summary_language", "disabled").value, null);
});

test("saveSetting writes project config and can unset", () => {
  const h = tempProject();
  try {
    const set = saveSetting({ cwd: h.project, env: h.env, scope: "project", key: "strictness", value: "gentle" });
    assert.equal(set.ok, true);
    const file = path.join(h.project, ".english-buddy.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { strictness: "gentle" });
    const unset = saveSetting({ cwd: h.project, env: h.env, scope: "project", key: "strictness", value: undefined });
    assert.equal(unset.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
  } finally {
    h.cleanup();
  }
});
