import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getSharedOnDate } from "./history.js";
import { fetchPerformanceForDate } from "./metabase.js";

const DATA_DIR     = process.env.DATA_DIR || "data";
const WEIGHTS_FILE = join(DATA_DIR, "weights.json");
const PERF_FILE    = join(DATA_DIR, "performance_log.json");

const TEST_GROUP_JID = "120363431273030908@g.us"; // "Test" group

const DEFAULT_WEIGHTS = {
  l30d_orders: 0.40,
  margin:      0.25,
  l7d_views:   0.20,
  l7d_shares:  0.15,
};

export function loadWeights() {
  try {
    return JSON.parse(readFileSync(WEIGHTS_FILE, "utf8"));
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
}

function saveWeights(w) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(WEIGHTS_FILE, JSON.stringify(w, null, 2));
}

function loadPerfLog() {
  try { return JSON.parse(readFileSync(PERF_FILE, "utf8")); } catch { return []; }
}

function savePerfLog(log) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PERF_FILE, JSON.stringify(log, null, 2));
}

function fmt(n) { return n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n); }

function buildSummaryText(dateStr, entries, oldWeights, newWeights) {
  const lines = [];
  lines.push(`📊 *Daily Learning — ${dateStr}*`);
  lines.push("");

  // Shared products
  const totalShared = entries.length;
  const categories = {};
  for (const e of entries) {
    categories[e.category] = (categories[e.category] || 0) + 1;
  }
  const catSummary = Object.entries(categories)
    .map(([c, n]) => `${c} ×${n}`)
    .join(", ");
  lines.push(`*Shared:* ${totalShared} products — ${catSummary}`);
  lines.push("");

  // Performance totals
  const totalOrders = entries.reduce((s, e) => s + (e.total_orders || 0), 0);
  const totalPPO    = entries.reduce((s, e) => s + (e.total_ppo    || 0), 0);
  const totalShares = entries.reduce((s, e) => s + (e.total_shares || 0), 0);
  lines.push(`*Performance (products shared):*`);
  lines.push(`Orders: ${fmt(totalOrders)} · PPO: ${fmt(totalPPO)} · Shares: ${fmt(totalShares)}`);
  lines.push("");

  // Top performers (by orders + PPO)
  const withData = entries.filter((e) => (e.total_orders || 0) + (e.total_ppo || 0) > 0);
  withData.sort((a, b) => (b.total_orders + b.total_ppo) - (a.total_orders + a.total_ppo));

  if (withData.length) {
    lines.push("*Top performers:*");
    for (const e of withData.slice(0, 5)) {
      lines.push(
        `• ${e.product_name || e.product_id} — ` +
        `${e.total_orders || 0} orders · ${e.total_ppo || 0} PPO · ${e.total_shares || 0} shares`
      );
    }
    lines.push("");
  }

  // Zero-order products
  const zeros = entries.filter((e) => !e.total_orders);
  if (zeros.length) {
    lines.push(`*No orders (${zeros.length} products):*`);
    const zeroNames = zeros.slice(0, 5).map((e) => e.sub_category || e.product_id).join(", ");
    lines.push(zeroNames + (zeros.length > 5 ? ` +${zeros.length - 5} more` : ""));
    lines.push("");
  }

  // Weight changes
  const changed = Object.keys(newWeights).filter(
    (k) => Math.abs((newWeights[k] || 0) - (oldWeights[k] || 0)) > 0.001
  );
  if (changed.length) {
    lines.push("*Weight adjustments:*");
    for (const k of changed) {
      const arrow = newWeights[k] > oldWeights[k] ? "↑" : "↓";
      lines.push(`${k}: ${oldWeights[k]?.toFixed(3)} → ${newWeights[k]?.toFixed(3)} ${arrow}`);
    }
  } else {
    lines.push("*Weights:* no change");
  }

  return lines.join("\n");
}

function adjustWeights(entries) {
  if (entries.length < 3) return loadWeights();

  const w = loadWeights();
  const withOrders = entries.filter((e) => (e.total_orders || 0) > 0);
  const orderRate  = withOrders.length / entries.length;
  const shareAvg   = entries.reduce((s, e) => s + (e.total_shares || 0), 0) / entries.length;

  if (orderRate > 0.3 && shareAvg > 2) {
    w.l7d_shares  = Math.min((w.l7d_shares  || 0.15) + 0.02, 0.35);
    w.l30d_orders = Math.max((w.l30d_orders || 0.40) - 0.01, 0.30);
  }
  if (orderRate < 0.1) {
    w.l7d_views   = Math.min((w.l7d_views   || 0.20) + 0.02, 0.35);
    w.l7d_shares  = Math.max((w.l7d_shares  || 0.15) - 0.01, 0.10);
  }

  const total = Object.values(w).reduce((s, v) => s + v, 0);
  for (const k of Object.keys(w)) w[k] = +(w[k] / total).toFixed(3);

  saveWeights(w);
  return w;
}

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

  const perf = await fetchPerformanceForDate(dateStr);
  const perfMap = Object.fromEntries(perf.map((r) => [r.customer_product_short_id, r]));

  const entries = sent.map((e) => {
    const p = perfMap[e.product_id] || {};
    return {
      product_id:    e.product_id,
      product_name:  e.product_name || "",
      category:      e.category,
      sub_category:  e.sub_category,
      price:         e.price,
      slot_hour:     e.slot_hour,
      total_orders:  p.total_orders  ?? 0,
      total_ppo:     p.total_ppo     ?? 0,
      total_shares:  p.total_shares  ?? 0,
    };
  });

  const log = loadPerfLog();
  log.push(...entries);
  savePerfLog(log);

  const oldWeights = loadWeights();
  const newWeights = adjustWeights(entries);

  console.log(`[Learning] ${entries.length} products | orders: ${entries.reduce((s,e)=>s+e.total_orders,0)} | weights:`, newWeights);

  // Send summary to Test group
  if (client?.isReady) {
    const summary = buildSummaryText(dateStr, entries, oldWeights, newWeights);
    await client.sendTextMessage(TEST_GROUP_JID, summary);
    console.log("[Learning] Summary sent to Test group");
  }
}
