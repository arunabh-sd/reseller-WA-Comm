import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getSharedOnDate } from "./history.js";
import { fetchProductPerformance } from "./metabase.js";

const DATA_DIR     = process.env.DATA_DIR || "data";
const WEIGHTS_FILE = join(DATA_DIR, "weights.json");
const PERF_FILE    = join(DATA_DIR, "performance_log.json");

// Default ranking weights
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
  try {
    return JSON.parse(readFileSync(PERF_FILE, "utf8"));
  } catch {
    return [];
  }
}

function savePerfLog(log) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PERF_FILE, JSON.stringify(log, null, 2));
}

// Runs once daily (at 8:30am IST) — evaluates yesterday's sends
export async function runDailyLearning() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split("T")[0];

  console.log(`[Learning] Evaluating ${dateStr}…`);

  const sent = getSharedOnDate(dateStr);
  if (!sent.length) {
    console.log("[Learning] Nothing sent yesterday, skipping");
    return;
  }

  const productIds = [...new Set(sent.map((e) => e.product_id))];
  const perf = await fetchProductPerformance(productIds);

  // Build performance lookup
  const perfMap = Object.fromEntries(
    perf.map((r) => [r.customer_product_short_id, r])
  );

  const entries = sent.map((e) => {
    const p = perfMap[e.product_id] || {};
    return {
      date:            dateStr,
      product_id:      e.product_id,
      category:        e.category,
      sub_category:    e.sub_category,
      price:           e.price,
      slot_hour:       e.slot_hour,
      reseller_orders: p.reseller_orders ?? 0,
      product_shares:  p.product_shares  ?? 0,
      product_views:   p.product_views   ?? 0,
    };
  });

  // Append to performance log
  const log = loadPerfLog();
  log.push(...entries);
  savePerfLog(log);

  // Simple weight adjustment: if shares signal strongly correlated with orders, boost it
  adjustWeights(entries);

  console.log(
    `[Learning] Logged ${entries.length} products | ` +
    `total reseller_orders: ${entries.reduce((s, e) => s + e.reseller_orders, 0)}`
  );
}

function adjustWeights(entries) {
  if (entries.length < 3) return; // not enough data

  const withOrders  = entries.filter((e) => e.reseller_orders > 0);
  const orderRate   = withOrders.length / entries.length;
  const shareAvg    = entries.reduce((s, e) => s + e.product_shares, 0) / entries.length;

  const w = loadWeights();

  // If share-heavy products led to orders, boost the shares weight slightly
  if (orderRate > 0.3 && shareAvg > 2) {
    w.l7d_shares   = Math.min(w.l7d_shares + 0.02, 0.40);
    w.l30d_orders  = Math.max(w.l30d_orders - 0.01, 0.30);
  }

  // If high-order-count products dominated (views correlate), boost views
  if (orderRate < 0.1) {
    w.l7d_views    = Math.min(w.l7d_views + 0.02, 0.40);
    w.l7d_shares   = Math.max(w.l7d_shares - 0.01, 0.10);
  }

  // Normalise to sum to 1.0
  const total = w.l30d_orders + w.l7d_views + w.l7d_shares;
  w.l30d_orders = +(w.l30d_orders / total).toFixed(3);
  w.l7d_views   = +(w.l7d_views   / total).toFixed(3);
  w.l7d_shares  = +(w.l7d_shares  / total).toFixed(3);

  saveWeights(w);
  console.log("[Learning] Updated weights:", w);
}
