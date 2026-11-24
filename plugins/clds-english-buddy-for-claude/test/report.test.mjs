import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { localDate } from "../scripts/lib/state.mjs";

const REPORT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "report.mjs");

function makeHistory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceb-report-"));
  const history = path.join(dir, "history");
  fs.mkdirSync(history, { recursive: true });
  const records = [
    { mode: "correct", original: "fix the autentication modul", corrected: "fix the authentication module", annotations: "autentication → authentication (spelling)\nmodul → module (spelling)", session: "s" },
    { mode: "correct", original: "its got bugs", corrected: "it's got bugs", annotations: "its → it's (apostrophe)", session: "s" },
    { mode: "correct", original: "its got more bugs", corrected: "it's got more bugs", annotations: "its → it's (apostrophe)", session: "s" },
    { mode: "clean", original: null, corrected: null, session: "s" },
    { mode: "translate", original: "改一下", corrected: "Change it", annotations: "(Chinese)", session: "s" },
  ].map((record) => ({ ts: new Date().toISOString(), ...record }));
  fs.writeFileSync(path.join(history, `${localDate()}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return dir;
}

function run(args) {
  return spawnSync(process.execPath, [REPORT, ...args], { encoding: "utf8" });
}

test("today report computes metrics and tables deterministically", () => {
  const dir = makeHistory();
  try {
    const result = run(["today", "--data-dir", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Prompts \| 5/);
    assert.match(result.stdout, /Corrections \| 4 \(80%\)/);
    assert.match(result.stdout, /its → it's/);
    assert.match(result.stdout, /Lessons of the Day/);
    assert.match(result.stdout, /apostrophe — 2 occurrences/);
    assert.match(result.stdout, /Rule.*apostrophe in contractions/);
    assert.match(result.stdout, /fix the authentication module/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stats report supports --days and JSON output", () => {
  const dir = makeHistory();
  try {
    const result = run(["stats", "--days", "7", "--data-dir", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Last 7 Days/);
    assert.match(result.stdout, /Total prompts \| 5/);

    const json = run(["stats", "--days", "7", "--json", "--data-dir", dir]);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.stats.total, 5);
    assert.equal(parsed.stats.corrections, 4);
    assert.equal(parsed.stats.patterns[0].original, "its");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mistakes report ranks all-time patterns", () => {
  const dir = makeHistory();
  try {
    const result = run(["mistakes", "--top", "2", "--data-dir", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Top 2 Patterns/);
    assert.match(result.stdout, /its \| it's \| 2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("empty history explains that the hook has not run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceb-empty-"));
  try {
    const result = run(["today", "--data-dir", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No prompts recorded today yet/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
