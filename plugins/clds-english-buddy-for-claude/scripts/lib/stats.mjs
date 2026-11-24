// History statistics. Pure computation over records; no model involvement.

import { parseAnnotations } from "./annotations.mjs";
import { listHistoryDates, localDate, readDay, readLastNDays, readToday } from "./state.mjs";

function countByMode(records) {
  const counts = { correct: 0, translate: 0, refine: 0, clean: 0 };
  for (const record of records) {
    const mode = record.mode || "clean";
    counts[mode] = (counts[mode] || 0) + 1;
  }
  return counts;
}

export function extractPatterns(records) {
  const patterns = new Map();
  for (const record of records) {
    if (record.mode === "translate") continue; // translation annotations are a language tag, not a diff
    for (const fix of parseAnnotations(record.annotations)) {
      const key = `${fix.original.toLowerCase()}\u0000${fix.corrected.toLowerCase()}`;
      const entry = patterns.get(key) || {
        original: fix.original,
        corrected: fix.corrected,
        count: 0,
        category: fix.category || "uncategorized",
      };
      entry.count += 1;
      if (fix.category) entry.category = fix.category;
      patterns.set(key, entry);
    }
  }
  return [...patterns.values()].sort((a, b) => b.count - a.count || a.original.localeCompare(b.original));
}

function summarize(records, days) {
  const total = records.length;
  const counts = countByMode(records);
  const corrections = total - counts.clean;
  return {
    days,
    total,
    corrections,
    clean: counts.clean,
    translations: counts.translate,
    refinements: counts.refine,
    errorRate: total > 0 ? Math.round((corrections / total) * 100) : 0,
    patterns: extractPatterns(records),
  };
}

export function todayStats(options = {}) {
  const records = readToday(options);
  return {
    date: localDate(),
    ...summarize(records, 1),
    records: records.filter((record) => record.mode !== "clean"),
  };
}

export function periodStats(days, options = {}) {
  return summarize(readLastNDays(days, options), days);
}

export function allTimeStats(options = {}) {
  const dates = listHistoryDates(options);
  const records = [];
  for (const date of dates) records.push(...readDay(date, options));
  return summarize(records, dates.length);
}

export function weeklyTrend(weeks = 4, options = {}) {
  const trend = [];
  const now = new Date();
  for (let index = 0; index < weeks; index += 1) {
    const end = new Date(now);
    end.setDate(end.getDate() - index * 7);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);

    const records = [];
    for (const date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      records.push(...readDay(localDate(date), options));
    }

    const total = records.length;
    const counts = countByMode(records);
    const corrections = total - counts.clean;
    trend.push({
      weekStart: localDate(start),
      weekEnd: localDate(end),
      total,
      corrections,
      errorRate: total > 0 ? Math.round((corrections / total) * 100) : 0,
      avgPerDay: total > 0 ? Math.round((corrections / 7) * 10) / 10 : 0,
    });
  }
  return trend.reverse();
}

export function categoryTotals(patterns) {
  const totals = new Map();
  for (const pattern of patterns) {
    const category = (pattern.category || "uncategorized").toLowerCase();
    const entry = totals.get(category) || { category, count: 0, patterns: [] };
    entry.count += pattern.count;
    entry.patterns.push(pattern);
    totals.set(category, entry);
  }
  return [...totals.values()].sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/**
 * Compare weekly error rates oldest -> newest.
 * Returns "improving", "regressing", "flat", or "insufficient-data".
 */
export function trendVerdict(trend) {
  const withData = trend.filter((week) => week.total > 0);
  if (withData.length < 2) return { verdict: "insufficient-data", delta: 0, weeks: withData.length };
  const first = withData[0].errorRate;
  const last = withData[withData.length - 1].errorRate;
  const delta = last - first;
  if (delta <= -5) return { verdict: "improving", delta, weeks: withData.length };
  if (delta >= 5) return { verdict: "regressing", delta, weeks: withData.length };
  return { verdict: "flat", delta, weeks: withData.length };
}
