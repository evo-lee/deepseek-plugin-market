#!/usr/bin/env node
// Deterministic language reports. The model only presents this output; it never
// recomputes the numbers. This matters on DeepSeek, where a model-driven report
// can silently miscount JSONL rows or invent patterns.

import process from "node:process";

import { historySummary, readDay, daysAgo, localDate } from "./lib/state.mjs";
import {
  allTimeStats,
  categoryTotals,
  periodStats,
  todayStats,
  trendVerdict,
  weeklyTrend,
} from "./lib/stats.mjs";

function parseArgs(argv) {
  const options = { report: "today", days: 30, top: null, json: false, dataDir: null, verbose: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "today" || arg === "stats" || arg === "mistakes") options.report = arg;
    else if (arg === "--days") options.days = positiveInteger(value(), "--days");
    else if (arg === "--top") options.top = positiveInteger(value(), "--top");
    else if (arg === "--data-dir") options.dataDir = value();
    else if (arg === "--json") options.json = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return options;
}

function positiveInteger(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`);
  return value;
}

function cell(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function pct(value) {
  return `${value}%`;
}

function fixesFor(record) {
  if (!record.annotations) return "—";
  const storage = typeof record.annotations === "string" ? record.annotations : "";
  return storage.replace(/\r?\n/g, "<br>") || "—";
}

function reportToday(options) {
  const today = todayStats(options);
  if (today.total === 0) {
    return `# Today's Language Report — ${today.date}\n\nNo prompts recorded today yet.\n\nIf you have been typing prompts, the coaching hook is not running. Run \`/clds-english-buddy-for-claude:doctor\`.\n`;
  }

  const yesterdayRecords = readDay(daysAgo(1), options);
  const yesterdayCorrections = yesterdayRecords.filter((record) => record.mode !== "clean").length;
  const yesterday = {
    total: yesterdayRecords.length,
    corrections: yesterdayCorrections,
    errorRate: yesterdayRecords.length > 0 ? Math.round((yesterdayCorrections / yesterdayRecords.length) * 100) : 0,
  };
  const week = periodStats(7, options);
  const trend = weeklyTrend(4, options);
  const verdict = trendVerdict(trend);

  const lines = [
    `# Today's Language Report — ${today.date}`,
    "",
    "## Overview",
    "",
    "| Metric | Today | Yesterday | 7-day avg |",
    "|--------|------:|----------:|----------:|",
    `| Prompts | ${today.total} | ${yesterday.total} | ${(week.total / 7).toFixed(1)} |`,
    `| Corrections | ${today.corrections} (${pct(today.errorRate)}) | ${yesterday.corrections} (${pct(yesterday.errorRate)}) | ${(week.corrections / 7).toFixed(1)} (${pct(week.errorRate)}) |`,
    `| Translations | ${today.translations} | — | ${week.translations} |`,
    `| Clean prompts | ${today.clean} | — | ${week.clean} |`,
    `| Refinements (::) | ${today.refinements} | — | ${week.refinements} |`,
    "",
    "## Today's Corrections",
    "",
  ];

  if (today.records.length === 0) {
    lines.push("No corrections today. Clean prompts are the goal.");
  } else {
    lines.push("| # | You Wrote | Corrected | Fixes |", "|---|-----------|-----------|-------|");
    today.records.forEach((record, index) => {
      const corrected = record.mode === "translate"
        ? `${record.corrected}${record.source_language ? ` (${record.source_language})` : ""}`
        : record.corrected;
      const fixes = record.mode === "refine" ? "refinement" : fixesFor(record);
      lines.push(`| ${index + 1} | ${cell(record.original)} | ${cell(corrected)} | ${fixes} |`);
    });
  }

  lines.push("", "## Recurring Patterns", "");
  const recurring = today.patterns.filter((pattern) => pattern.count > 1);
  if (recurring.length === 0) {
    lines.push("No pattern repeated more than once today.");
  } else {
    lines.push("| Pattern | Count Today | Category |", "|---------|:-----------:|----------|");
    for (const pattern of recurring) {
      lines.push(`| \`${cell(pattern.original)} → ${cell(pattern.corrected)}\` | ${pattern.count} | ${cell(pattern.category)} |`);
    }
  }

  lines.push("", "## Focus Areas", "");
  const categories = categoryTotals(today.patterns).slice(0, 3);
  if (categories.length === 0) {
    lines.push("No recurring categories today.");
  } else {
    for (const entry of categories) {
      lines.push(`### ${entry.category} — ${entry.count} occurrence${entry.count === 1 ? "" : "s"}`, "");
      for (const pattern of entry.patterns.slice(0, 3)) {
        lines.push(`- \`${pattern.original} → ${pattern.corrected}\`${pattern.category ? ` (${pattern.category})` : ""}`);
      }
      lines.push("");
    }
  }

  lines.push("## Trend", "", "| Week | Error Rate | Corrections/Day |", "|------|:----------:|:---------------:|");
  for (const item of trend) {
    lines.push(`| ${item.weekStart} — ${item.weekEnd} | ${item.total > 0 ? pct(item.errorRate) : "—"} | ${item.total > 0 ? item.avgPerDay : "—"} |`);
  }
  lines.push("", verdictSentence(verdict));

  if (options.verbose) lines.push("", `_Data: ${historySummary(options).dataDir}_`);
  return `${lines.join("\n")}\n`;
}

function reportStats(options) {
  const stats = periodStats(options.days, options);
  if (stats.total === 0) {
    return `# Language Stats — Last ${options.days} Days\n\nNo prompts recorded in this window yet.\n`;
  }
  const trend = weeklyTrend(Math.ceil(options.days / 7), options);
  const verdict = trendVerdict(trend);
  const top = stats.patterns.slice(0, 10);
  const lines = [
    `# Language Stats — Last ${options.days} Days`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|--------|------:|",
    `| Total prompts | ${stats.total} |`,
    `| Corrections made | ${stats.corrections} (${pct(stats.errorRate)}) |`,
    `| Translations | ${stats.translations} |`,
    `| Refinements | ${stats.refinements} |`,
    `| Clean prompts | ${stats.clean} (${pct(100 - stats.errorRate)}) |`,
    "",
    "## Top 10 Recurring Mistakes",
    "",
  ];
  if (top.length === 0) {
    lines.push("No recurring patterns in this window.");
  } else {
    lines.push("| # | You Write | Should Be | Times |", "|---|-----------|-----------|------:|");
    top.forEach((pattern, index) => {
      lines.push(`| ${index + 1} | ${cell(pattern.original)} | ${cell(pattern.corrected)} | ${pattern.count} |`);
    });
  }

  lines.push("", "## Weekly Trend", "", "| Week | Prompts | Corrections | Error Rate |", "|------|--------:|------------:|-----------:|");
  for (const item of trend) {
    lines.push(`| ${item.weekStart} — ${item.weekEnd} | ${item.total} | ${item.corrections} | ${item.total > 0 ? pct(item.errorRate) : "—"} |`);
  }
  lines.push("", "## Analysis", "", verdictSentence(verdict));

  const categories = categoryTotals(stats.patterns).slice(0, 3);
  if (categories.length > 0) {
    lines.push("", "### Focus Categories", "");
    for (const entry of categories) {
      const share = stats.corrections > 0 ? Math.round((entry.count / stats.corrections) * 100) : 0;
      lines.push(`- **${entry.category}** — ${entry.count} occurrences (${share}% of corrections); top: \`${entry.patterns[0]?.original} → ${entry.patterns[0]?.corrected}\``);
    }
  }
  if (options.verbose) lines.push("", `_Data: ${historySummary(options).dataDir}_`);
  return `${lines.join("\n")}\n`;
}

function reportMistakes(options) {
  const stats = allTimeStats(options);
  const topN = options.top ?? 20;
  const patterns = stats.patterns.slice(0, topN);
  const lines = [
    "# Recurring Mistakes",
    "",
    `**Period**: All time (${stats.total} prompts, ${stats.corrections} corrections)`,
    "",
    `## Top ${topN} Patterns`,
    "",
  ];
  if (patterns.length === 0) {
    lines.push("No corrections recorded yet.");
  } else {
    lines.push("| # | You Write | Should Be | Times | Category |", "|---|-----------|-----------|------:|----------|");
    patterns.forEach((pattern, index) => {
      lines.push(`| ${index + 1} | ${cell(pattern.original)} | ${cell(pattern.corrected)} | ${pattern.count} | ${cell(pattern.category)} |`);
    });
  }

  lines.push("", "## Focus Areas", "");
  const categories = categoryTotals(stats.patterns).slice(0, 3);
  if (categories.length === 0) {
    lines.push("No categories yet.");
  } else {
    for (const entry of categories) {
      lines.push(`### ${entry.category}: ${entry.count} total occurrences`, "");
      for (const pattern of entry.patterns.slice(0, 3)) {
        lines.push(`- \`${pattern.original} → ${pattern.corrected}\` (${pattern.count}×)`);
      }
      lines.push("");
    }
  }
  if (options.verbose) lines.push(`_Data: ${historySummary(options).dataDir}_`);
  return `${lines.join("\n")}\n`;
}

function verdictSentence(verdict) {
  switch (verdict.verdict) {
    case "improving":
      return `You're improving. Error rate down ${Math.abs(verdict.delta)} percentage points over ${verdict.weeks} weeks.`;
    case "regressing":
      return `Error rate is up ${verdict.delta} percentage points over ${verdict.weeks} weeks. Slow down and re-read before submitting.`;
    case "flat":
      return `Holding steady across ${verdict.weeks} weeks. Focus on your recurring patterns to break through.`;
    default:
      return "Not enough weekly data yet for a trend. Keep typing; the report improves with history.";
  }
}

function printHelp() {
  process.stdout.write(`Usage: node report.mjs [today|stats|mistakes] [--days N] [--top N] [--data-dir DIR] [--json] [--verbose]\n`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`report: ${error.message}\n`);
    printHelp();
    process.exit(2);
  }
  if (options.help) {
    printHelp();
    return;
  }

  const dataOptions = { explicit: options.dataDir };
  if (options.json) {
    if (options.report === "today") {
      const today = todayStats(dataOptions);
      const yesterdayRecords = readDay(daysAgo(1), dataOptions);
      process.stdout.write(`${JSON.stringify({
        date: localDate(),
        today,
        yesterday: {
          total: yesterdayRecords.length,
          corrections: yesterdayRecords.filter((record) => record.mode !== "clean").length,
        },
        week: periodStats(7, dataOptions),
        trend: weeklyTrend(4, dataOptions),
      })}\n`);
    } else {
      const stats = options.report === "mistakes"
        ? allTimeStats(dataOptions)
        : periodStats(options.days, dataOptions);
      if (options.report === "mistakes" && options.top) stats.patterns = stats.patterns.slice(0, options.top);
      process.stdout.write(`${JSON.stringify({ report: options.report, stats, trend: weeklyTrend(Math.ceil(options.days / 7), dataOptions) })}\n`);
    }
    return;
  }

  const report = options.report === "today"
    ? reportToday({ ...options, ...dataOptions })
    : options.report === "stats"
      ? reportStats({ ...options, ...dataOptions })
      : reportMistakes({ ...options, ...dataOptions });
  process.stdout.write(report);
}

main();
