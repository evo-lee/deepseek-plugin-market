// Correction history. One JSONL file per local calendar day.
//
// The data directory is resolved by paths.mjs, so hooks (which get
// CLAUDE_PLUGIN_DATA from Claude Code) and slash-command Bash tools (which may
// not) read and write the same history.

import fs from "node:fs";
import path from "node:path";

import { resolveDataDir } from "./paths.mjs";

function historyDir(options = {}) {
  const dataDir = resolveDataDir(options);
  const dir = path.join(dataDir, "history");
  fs.mkdirSync(dir, { recursive: true });
  return { dataDir, dir };
}

// Local calendar day, never toISOString(): that buckets the UTC day and files
// prompts typed before 08:00 in UTC+8 under the previous date.
export function localDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDate(date);
}

function parseLocalDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function dateFile(date, options) {
  const { dir } = historyDir(options);
  return path.join(dir, `${date}.jsonl`);
}

function appendRecord(record, options) {
  try {
    const file = dateFile(localDate(), options);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    return { ok: true, file, record };
  } catch (error) {
    return { ok: false, error, record };
  }
}

function sessionOf(entry) {
  return entry.session || process.env.CLAUDE_SESSION_ID || null;
}

export function logCorrection(entry, options = {}) {
  const record = {
    ts: new Date().toISOString(),
    mode: entry.mode,
    original: entry.original,
    corrected: entry.corrected,
    annotations: entry.annotations || null,
    source_language: entry.sourceLanguage || null,
    provider: entry.provider || null,
    model: entry.model || null,
    session: sessionOf(entry),
  };
  const result = appendRecord(record, options);
  return { ...result, record };
}

export function logClean(entry = {}, options = {}) {
  const record = {
    ts: new Date().toISOString(),
    mode: "clean",
    original: null,
    corrected: null,
    provider: entry.provider || null,
    model: entry.model || null,
    session: sessionOf(entry),
  };
  const result = appendRecord(record, options);
  return { ...result, record };
}

export function logMetric(entry, options = {}) {
  try {
    const dataDir = resolveDataDir(options);
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, "coaching-metrics.jsonl");
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf8");
    return { ok: true, file };
  } catch (error) {
    return { ok: false, error };
  }
}

export function readDay(date, options = {}) {
  const file = dateFile(date, options);
  if (!fs.existsSync(file)) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function readToday(options = {}) {
  return readDay(localDate(), options);
}

export function readRange(startDate, endDate, options = {}) {
  const records = [];
  const end = parseLocalDate(endDate);
  for (const date = parseLocalDate(startDate); date <= end; date.setDate(date.getDate() + 1)) {
    records.push(...readDay(localDate(date), options));
  }
  return records;
}

export function readLastNDays(days, options = {}) {
  return readRange(daysAgo(days - 1), localDate(), options);
}

export function listHistoryDates(options = {}) {
  const { dir } = historyDir(options);
  try {
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => file.replace(/\.jsonl$/, ""))
      .sort();
  } catch {
    return [];
  }
}

export function readMetrics(options = {}, limit = 20) {
  try {
    const dataDir = resolveDataDir(options);
    const file = path.join(dataDir, "coaching-metrics.jsonl");
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function historySummary(options = {}) {
  const dataDir = resolveDataDir(options);
  const dates = listHistoryDates(options);
  const today = readToday(options);
  return {
    dataDir,
    historyDir: path.join(dataDir, "history"),
    days: dates.length,
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null,
    todayRecords: today.length,
  };
}
