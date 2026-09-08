import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getSharedOnDate } from "./history.js";
import { fetchPerformanceForDate } from "./metabase.js";

const DATA_DIR        = process.env.DATA_DIR || "data";
const WEIGHTS_FILE    = join(DATA_DIR, "weights.json");
const PERF_FILE       = join(DATA_DIR, "performance_log.json");
const SUBCAT_PERF_FILE = join(DATA_DIR, "subcategory_perf.json");

const TEST_GROUP_JID = "120363431273030908@g.us"; // "Test" group

const DEFAULT_WEIGHTS = {
  l30d_orders:     0.40,
  margin:          0.25,
  l7d_views:       0.20,
  l7d_shares:      0.15,
  exclusive:       0.00, // learned — boosted if exclusive products outperform
  marketplace_gap: 0.00, // learned — boosted if price-gap products outperform
};

// ── Persistence ───────────────────────────────────────────────────────────────

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
function writeJson(path, data) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export function loadWeights() {
  return { ...DEFAULT_WEIGHTS, ...readJson(WEIGHTS_FILE, {}) };
}

export function loadSubcategoryPerf() {
  return readJson(SUBCAT_PERF_FILE, {});
}

// ── Correlation analysis ──────────────────────────────────────────────────────

function avg(items, key) {
  if (!items.length) return 0;
  return items.reduce((s, e) => s + (e[key] || 0), 0) / items.length;
}

function groupBy(items, key) {
  const result = {};
  for (const item of items) {
    const k = String(item[key] ?? "unknown");
    if (!result[k]) result[k] = [];
    result[k].push(item);
  }
  return result;
}

function analyzeCorrelations(entries) {
  // 1. By sub-category
  const bySub = groupBy(entries, "sub_category");
  const bySubCat = Object.entries(bySub)
    .map(([label, items]) => ({
      label,
      avg_orders: avg(items, "total_orders"),
      avg_ppo:    avg(items, "total_ppo"),
      count:      items.length,
    }))
    .sort((a, b) => b.avg_orders - a.avg_orders);

  // 2. By AOV bucket
  const byAov = groupBy(entries, "aov_bucket");
  const byAovBucket = Object.entries(byAov)
    .map(([label, items]) => ({
      label,
      avg_orders: avg(items, "total_orders"),
      count:      items.length,
    }))
    .sort((a, b) => b.avg_orders - a.avg_orders);

  // 3. Exclusive vs non-exclusive
  const excl    = entries.filter((e) => e.exclusive);
  const nonExcl = entries.filter((e) => !e.exclusive);
  const exclusiveCorr = {
    exclusive_avg:     avg(excl,    "total_orders"),
    non_exclusive_avg: avg(nonExcl, "total_orders"),
    exclusive_count:   excl.length,
    non_exclusive_count: nonExcl.length,
  };

  // 4. Marketplace gap band (no gap / small ≤500 / big >500)
  const noGap    = entries.filter((e) => (e.marketplace_gap || 0) === 0);
  const smallGap = entries.filter((e) => (e.marketplace_gap || 0) > 0 && e.marketplace_gap <= 500);
  const bigGap   = entries.filter((e) => (e.marketplace_gap || 0) > 500);
  const mktGapCorr = [
    { label: "No gap",   avg_orders: avg(noGap,    "total_orders"), count: noGap.length },
    { label: "Gap ≤₹500", avg_orders: avg(smallGap, "total_orders"), count: smallGap.length },
    { label: "Gap >₹500", avg_orders: avg(bigGap,   "total_orders"), count: bigGap.length },
  ].filter((x) => x.count > 0);

  // 5. By time band
  const timeBands = {
    "Morning (9–12)":   entries.filter((e) => e.slot_hour >= 9  && e.slot_hour < 12),
    "Afternoon (12–15)": entries.filter((e) => e.slot_hour >= 12 && e.slot_hour < 15),
    "Evening (15–18)":  entries.filter((e) => e.slot_hour >= 15 && e.slot_hour < 18),
    "Night (18–20)":    entries.filter((e) => e.slot_hour >= 18),
  };
  const byTimeBand = Object.entries(timeBands)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({
      label,
      avg_orders: avg(items, "total_orders"),
      count:      items.length,
    }))
    .sort((a, b) => b.avg_orders - a.avg_orders);

  return { bySubCat, byAovBucket, exclusiveCorr, mktGapCorr, byTimeBand };
}

// ── Sub-category performance EMA update ───────────────────────────────────────

const SUBCAT_ALPHA = 0.3; // EMA smoothing — 30% weight to today, 70% to history

function updateSubcategoryPerf(bySubCat) {
  const existing = loadSubcategoryPerf();
  for (const { label, avg_orders, count } of bySubCat) {
    if (!label || label === "unknown") continue;
    const prev = existing[label];
    if (!prev) {
      existing[label] = { ema_orders: avg_orders, samples: count };
    } else {
      existing[label] = {
        ema_orders: SUBCAT_ALPHA * avg_orders + (1 - SUBCAT_ALPHA) * prev.ema_orders,
        samples:    prev.samples + count,
      };
    }
  }
  writeJson(SUBCAT_PERF_FILE, existing);
  return existing;
}

// ── Weight adjustment ─────────────────────────────────────────────────────────

function adjustWeights(entries, corr) {
  const w = loadWeights();

  // Basic overall adjustments (existing logic)
  const orderRate = entries.filter((e) => e.total_orders > 0).length / Math.max(entries.length, 1);
  const shareAvg  = avg(entries, "total_shares");

  if (orderRate > 0.3 && shareAvg > 2) {
    w.l7d_shares  = Math.min((w.l7d_shares  || 0.15) + 0.02, 0.35);
    w.l30d_orders = Math.max((w.l30d_orders || 0.40) - 0.01, 0.25);
  }
  if (orderRate < 0.1) {
    w.l7d_views   = Math.min((w.l7d_views   || 0.20) + 0.02, 0.35);
    w.l7d_shares  = Math.max((w.l7d_shares  || 0.15) - 0.01, 0.10);
  }

  // Exclusive signal: if exclusive products convert >1.5x better, bump weight
  const { exclusive_avg, non_exclusive_avg, exclusive_count } = corr.exclusiveCorr;
  if (exclusive_count >= 3) {
    const ratio = exclusive_avg / Math.max(non_exclusive_avg, 0.01);
    if (ratio > 1.5) {
      w.exclusive = Math.min((w.exclusive || 0) + 0.03, 0.15);
    } else if (ratio < 0.8) {
      w.exclusive = Math.max((w.exclusive || 0) - 0.01, 0);
    }
  }

  // Marketplace gap signal: if gap>₹500 converts >1.5x better than no-gap products
  const bigGapRow = corr.mktGapCorr.find((r) => r.label === "Gap >₹500");
  const noGapRow  = corr.mktGapCorr.find((r) => r.label === "No gap");
  if (bigGapRow && noGapRow && bigGapRow.count >= 3) {
    const mktRatio = bigGapRow.avg_orders / Math.max(noGapRow.avg_orders, 0.01);
    if (mktRatio > 1.5) {
      w.marketplace_gap = Math.min((w.marketplace_gap || 0) + 0.03, 0.15);
    } else if (mktRatio < 0.8) {
      w.marketplace_gap = Math.max((w.marketplace_gap || 0) - 0.01, 0);
    }
  }

  // Normalise all weights so they sum to 1
  const total = Object.values(w).reduce((s, v) => s + v, 0);
  if (total > 0) {
    for (const k of Object.keys(w)) w[k] = +((w[k] || 0) / total).toFixed(4);
  }

  writeJson(WEIGHTS_FILE, w);
  return w;
}

// ── Summary text ──────────────────────────────────────────────────────────────

function fmtN(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

function buildSummaryText(dateStr, entries, corr, oldWeights, newWeights) {
  const lines = [];
  lines.push(`📊 *Daily Learning — ${dateStr}*`);
  lines.push("");

  // Totals
  const cats = {};
  for (const e of entries) cats[e.category] = (cats[e.category] || 0) + 1;
  lines.push(`*Shared:* ${entries.length} products — ${Object.entries(cats).map(([c, n]) => `${c} ×${n}`).join(", ")}`);
  const totalOrders = entries.reduce((s, e) => s + (e.total_orders || 0), 0);
  const totalPPO    = entries.reduce((s, e) => s + (e.total_ppo    || 0), 0);
  const totalShares = entries.reduce((s, e) => s + (e.total_shares || 0), 0);
  lines.push(`Orders: ${fmtN(totalOrders)} · PPO: ${fmtN(totalPPO)} · Shares: ${fmtN(totalShares)}`);
  lines.push("");

  // Sub-category breakdown (top 4 + bottom mention)
  if (corr.bySubCat.length) {
    lines.push("*Sub-category performance:*");
    const top = corr.bySubCat.slice(0, 4);
    for (const s of top) {
      lines.push(`• ${s.label}: ${s.avg_orders.toFixed(1)} avg orders (${s.count} products)`);
    }
    if (corr.bySubCat.length > 4) {
      const worst = corr.bySubCat[corr.bySubCat.length - 1];
      lines.push(`• Worst: ${worst.label} — ${worst.avg_orders.toFixed(1)} avg orders`);
    }
    lines.push("");
  }

  // AOV bucket
  if (corr.byAovBucket.length > 1) {
    const best = corr.byAovBucket[0];
    lines.push(`*AOV:* ${best.label} bucket led — ${best.avg_orders.toFixed(1)} avg orders (vs ${corr.byAovBucket.slice(1).map((b) => `${b.label}: ${b.avg_orders.toFixed(1)}`).join(", ")})`);
    lines.push("");
  }

  // Exclusive vs standard
  const { exclusive_avg, non_exclusive_avg, exclusive_count, non_exclusive_count } = corr.exclusiveCorr;
  if (exclusive_count > 0) {
    const ratio = exclusive_avg / Math.max(non_exclusive_avg, 0.01);
    const tag   = ratio > 1.5 ? " ↑ boosting exclusive weight" : ratio < 0.8 ? " (no edge)" : "";
    lines.push(`*Exclusive (${exclusive_count}):* ${exclusive_avg.toFixed(1)} orders · *Standard (${non_exclusive_count}):* ${non_exclusive_avg.toFixed(1)} orders${tag}`);
    lines.push("");
  }

  // Marketplace gap
  if (corr.mktGapCorr.length > 1) {
    const parts = corr.mktGapCorr.map((r) => `${r.label}: ${r.avg_orders.toFixed(1)}`).join(" · ");
    lines.push(`*Price gap vs marketplace:* ${parts}`);
    lines.push("");
  }

  // Time band
  if (corr.byTimeBand.length > 1) {
    const best = corr.byTimeBand[0];
    lines.push(`*Best time:* ${best.label} — ${best.avg_orders.toFixed(1)} avg orders`);
    lines.push("");
  }

  // Weight changes
  const changed = Object.keys(newWeights).filter(
    (k) => Math.abs((newWeights[k] || 0) - (oldWeights[k] || 0)) > 0.0005
  );
  if (changed.length) {
    lines.push("*Weight adjustments:*");
    for (const k of changed) {
      const arrow = newWeights[k] > (oldWeights[k] || 0) ? "↑" : "↓";
      lines.push(`${k}: ${(oldWeights[k] || 0).toFixed(3)} → ${newWeights[k].toFixed(3)} ${arrow}`);
    }
  } else {
    lines.push("*Weights:* no change today");
  }

  return lines.join("\n");
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runDailyLearning(client) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split("T")[0];

  console.log(`[Learning] Evaluating ${dateStr}…`);

  const sent = getSharedOnDate(dateStr);
  if (!sent.length) {
    console.log("[Learning] Nothing sent yesterday — skipping");
    if (client?.isReady) {
      await client.sendTextMessage(TEST_GROUP_JID, `📊 *Daily Learning — ${dateStr}*\n\nNothing was shared yesterday.`);
    }
    return;
  }

  const perf    = await fetchPerformanceForDate(dateStr);
  const perfMap = Object.fromEntries(perf.map((r) => [r.customer_product_short_id, r]));

  const entries = sent.map((e) => {
    const p = perfMap[e.product_id] || {};
    return {
      ...e,
      total_orders: p.total_orders ?? 0,
      total_ppo:    p.total_ppo    ?? 0,
      total_shares: p.total_shares ?? 0,
    };
  });

  // Persist raw log
  const log = readJson(PERF_FILE, []);
  log.push(...entries);
  writeJson(PERF_FILE, log);

  // Correlation analysis
  const corr = analyzeCorrelations(entries);

  // Update sub-category performance memory (EMA)
  updateSubcategoryPerf(corr.bySubCat);

  // Adjust weights
  const oldWeights = loadWeights();
  const newWeights = adjustWeights(entries, corr);

  console.log(`[Learning] ${entries.length} products | orders: ${entries.reduce((s, e) => s + e.total_orders, 0)} | weights:`, newWeights);

  // Send summary to Test group
  if (client?.isReady) {
    const summary = buildSummaryText(dateStr, entries, corr, oldWeights, newWeights);
    await client.sendTextMessage(TEST_GROUP_JID, summary);
    console.log("[Learning] Summary sent to Test group");
  }
}
