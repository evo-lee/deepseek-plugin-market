#!/usr/bin/env node
// SessionEnd hook: a short summary of today's coaching in this profile.
// Written to stderr so it never becomes model context.

import fs from "node:fs";
import process from "node:process";

import { parseAnnotations } from "./lib/annotations.mjs";
import { readToday } from "./lib/state.mjs";

function readStdin() {
  try {
    const text = fs.readFileSync(0, "utf8").trim();
    return text === "" ? {} : JSON.parse(text);
  } catch {
    return {};
  }
}

function main() {
  const input = readStdin();
  const session = input.session_id || process.env.CLAUDE_SESSION_ID || null;
  let records;
  try {
    records = readToday();
  } catch {
    return;
  }
  if (session) {
    const scoped = records.filter((record) => record.session === session);
    if (scoped.length > 0) records = scoped;
  }
  if (records.length === 0) return;

  const corrections = records.filter((record) => record.mode === "correct");
  const translations = records.filter((record) => record.mode === "translate");
  const refinements = records.filter((record) => record.mode === "refine");
  const clean = records.filter((record) => record.mode === "clean");
  if (corrections.length === 0 && translations.length === 0 && refinements.length === 0) return;

  const parts = [`Session language stats: ${records.length} prompts`];
  if (corrections.length > 0) parts.push(`${corrections.length} corrections`);
  if (translations.length > 0) parts.push(`${translations.length} translations`);
  if (refinements.length > 0) parts.push(`${refinements.length} refinements`);
  if (clean.length > 0) parts.push(`${clean.length} clean`);
  process.stderr.write(`${parts.join(", ")}\n`);

  const fixes = new Map();
  for (const record of corrections) {
    for (const fix of parseAnnotations(record.annotations)) {
      const key = `${fix.original.toLowerCase()}|${fix.corrected.toLowerCase()}`;
      const entry = fixes.get(key) || { label: `${fix.original} → ${fix.corrected}`, count: 0 };
      entry.count += 1;
      fixes.set(key, entry);
    }
  }
  const recurring = [...fixes.values()]
    .filter((entry) => entry.count >= 2)
    .sort((a, b) => b.count - a.count);
  if (recurring.length > 0) {
    process.stderr.write(`Recurring this session: ${recurring.map((entry) => `${entry.label} (${entry.count}x)`).join(", ")}\n`);
  }
}

main();
