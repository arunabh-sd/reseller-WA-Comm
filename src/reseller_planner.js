import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { fetchResellerEvents } from "./metabase.js";
import { getProductMap } from "./cache.js";
import { getSharedForReseller } from "./reseller_history.js";
import { cleanPhone } from "./reseller_jids.js";

const DATA_DIR  = process.env.DATA_DIR || "data";
const PLANS_DIR = join(DATA_DIR, "reseller_plans");

const PRODUCTS_PER_RESELLER = 8;

// Activity signal weights: orders matter most, shares next, browses least
const ACTIVITY_WEIGHT = { Ordered: 4, Shared: 2, Browsed: 1 };

// Recency exponential decay — half-life of 14 days
const HALF_LIFE_DAYS = 14;

// ── Date parsing ──────────────────────────────────────────────────────────────
// Handles both "2026-09-16" (Metabase API) and "16-9-2026" (CSV export format)
function parseDate(str) {
  if (!str) return new Date();
  const parts = String(str).split("-");
  if (parts.length !== 3) return new Date(str);
  const [a, b, c] = parts.map(Number);
  return parts[0].length === 4
    ? new Date(a, b - 1, c)   // YYYY-MM-DD
    : new Date(c, b - 1, a);  // DD-M-YYYY
}

function recencyWeight(dateStr) {
  const daysAgo = (Date.now() - parseDate(dateStr).getTime()) / 86400000;
  return Math.exp((-daysAgo * Math.LN2) / HALF_LIFE_DAYS);
}

// ── Reseller profile ──────────────────────────────────────────────────────────
// Returns { subcatScores: Map<type→score>, avgOrderPrice }
function buildProfile(events, productMap) {
  const subcatRaw   = new Map();  // clean_product_type → weighted score
  const orderedPrices = [];

  for (const ev of events) {
    const product = productMap.get(ev.product_id);
    if (!product) continue;

    const weight = (ACTIVITY_WEIGHT[ev.activity_type] || 0) * recencyWeight(ev.activity_date);
    if (!weight) continue;

    const sc = product.clean_product_type;
    subcatRaw.set(sc, (subcatRaw.get(sc) || 0) + weight);

    if (ev.activity_type === "Ordered" && product.reseller_selling_price) {
      orderedPrices.push(product.reseller_selling_price);
    }
  }

  // Normalise to 0–1
  const maxScore = Math.max(...subcatRaw.values(), 1);
  const subcatScores = new Map();
  for (const [sc, s] of subcatRaw) subcatScores.set(sc, s / maxScore);

  const avgOrderPrice = orderedPrices.length
    ? orderedPrices.reduce((s, p) => s + p, 0) / orderedPrices.length
    : 500; // default mid-range if no order history

  return { subcatScores, avgOrderPrice };
}

// ── Product scoring for a reseller ───────────────────────────────────────────
// Factors (in priority order):
//   55% subcategory affinity  — did this reseller engage with similar products?
//   25% AOV similarity        — is the price near their typical order value?
//   20% product popularity    — reseller-channel orders in last 30d (normalised)
function scoreProducts(candidates, profile, maxResellerOrders) {
  return candidates.map(p => {
    const subScore   = profile.subcatScores.get(p.clean_product_type) || 0;
    const priceDiff  = Math.abs((p.reseller_selling_price || 0) - profile.avgOrderPrice);
    const priceScore = Math.max(0, 1 - priceDiff / 1500); // ₹1500 diff = 0 score
    const popScore   = (p.reseller_orders_last_30d || 0) / Math.max(maxResellerOrders, 1);
    return { ...p, _score: 0.55 * subScore + 0.25 * priceScore + 0.20 * popScore };
  });
}

// ── Main planning run ─────────────────────────────────────────────────────────
export async function runResellerPlanner() {
  console.log("[ResellerPlanner] Starting daily planning run…");

  // Fetch last 60 days of activity for rich profiles
  const today    = new Date();
  const endDate  = today.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const startDay = new Date(today - 60 * 86400000);
  const startDate = startDay.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  const [events, productMap] = await Promise.all([
    fetchResellerEvents(startDate, endDate),
    getProductMap(),
  ]);

  if (!events.length) {
    console.log("[ResellerPlanner] No events returned — skipping");
    return [];
  }

  // Group by reseller
  const byReseller = new Map();
  for (const ev of events) {
    if (!byReseller.has(ev.reseller_id)) {
      byReseller.set(ev.reseller_id, {
        reseller_id:   ev.reseller_id,
        reseller_name: ev.reseller_name,
        phone:         cleanPhone(ev.reseller_phone),
        events:        [],
      });
    }
    byReseller.get(ev.reseller_id).events.push(ev);
  }

  console.log(`[ResellerPlanner] ${byReseller.size} unique resellers found`);

  // Pre-compute normalisation constant across full catalog
  const allProducts = [...productMap.values()].filter(p => p.reseller_selling_price);
  const maxResellerOrders = Math.max(...allProducts.map(p => p.reseller_orders_last_30d || 0), 1);

  const plans = [];

  for (const [resellerId, reseller] of byReseller) {
    const alreadyShared = getSharedForReseller(resellerId);
    const profile       = buildProfile(reseller.events, productMap);

    const eligible = allProducts.filter(p => !alreadyShared.has(p.customer_product_short_id));
    if (!eligible.length) {
      console.log(`[ResellerPlanner] ${reseller.reseller_name}: all products already shared — skipping`);
      continue;
    }

    const scored = scoreProducts(eligible, profile, maxResellerOrders)
      .sort((a, b) => b._score - a._score)
      .slice(0, PRODUCTS_PER_RESELLER);

    plans.push({
      reseller_id:   resellerId,
      reseller_name: reseller.reseller_name,
      phone:         reseller.phone,
      products: scored.map(p => ({
        product_id:              p.customer_product_short_id,
        product_name:            p.product_name,
        img_link:                p.img_link,
        qrate_url:               p.qrate_url,
        reseller_selling_price:  p.reseller_selling_price,
        clean_product_type:      p.clean_product_type,
        _score:                  Math.round(p._score * 1000) / 1000,
      })),
    });
  }

  // Persist plan
  mkdirSync(PLANS_DIR, { recursive: true });
  const planFile = join(PLANS_DIR, `${endDate}.json`);
  writeFileSync(planFile, JSON.stringify(plans, null, 2));
  console.log(`[ResellerPlanner] Saved plan: ${plans.length} resellers → ${planFile}`);

  return plans;
}

// Load today's plan (null if not yet generated)
export function loadTodayPlan() {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  try {
    return JSON.parse(readFileSync(join(PLANS_DIR, `${today}.json`), "utf8"));
  } catch {
    return null;
  }
}

// Load plan for a specific date string (YYYY-MM-DD)
export function loadPlanForDate(dateStr) {
  try {
    return JSON.parse(readFileSync(join(PLANS_DIR, `${dateStr}.json`), "utf8"));
  } catch {
    return null;
  }
}
