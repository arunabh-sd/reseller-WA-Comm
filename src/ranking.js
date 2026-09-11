import { getProductMap } from "./cache.js";
import { CATEGORY_TYPES } from "./config/categories.js";
import { AOV_BUCKETS, MIN_L30D_ORDERS, PRODUCTS_PER_SHARE } from "./config/schedule.js";
import { getRecentlyShared } from "./history.js";
import { loadWeights, loadSubcategoryPerf } from "./learning.js";

// Maps slot category names → category_l1 strings from product_labels.json
const CATEGORY_L1_MAP = {
  kurti:     "Kurtas, Kurtis & Sets",
  saree:     "Sarees",
  jewellery: "Jewellery",
  western:   "Western Wear",
  bags:      "Bags",
};

function normalise(arr) {
  const max = Math.max(...arr, 1);
  return arr.map((v) => v / max);
}

// Average EMA orders across known sub-categories within this slot's valid types
function categoryAvgOrders(subPerf, validTypes) {
  const entries = Object.entries(subPerf).filter(([sc]) => validTypes.has(sc));
  if (!entries.length) return 1;
  return entries.reduce((s, [, e]) => s + e.ema_orders, 0) / entries.length;
}

// Historical performance multiplier for a sub-category. Returns 1.0 if not enough data.
function subcatBoost(subPerf, sc, catAvg) {
  const entry = subPerf[sc];
  if (!entry || entry.samples < 3) return 1.0;
  const ratio = entry.ema_orders / Math.max(catAvg, 0.01);
  return Math.max(0.7, Math.min(1.5, ratio)); // clamp so one great day doesn't dominate
}

export async function getRankedForSlot({ category, aovBucket }) {
  const weights   = loadWeights();
  const recentIds = getRecentlyShared();
  const products  = await getProductMap();

  const validTypes  = new Set(CATEGORY_TYPES[category] || []);
  const band        = AOV_BUCKETS[aovBucket] || AOV_BUCKETS.any;
  const expectedL1  = CATEGORY_L1_MAP[category];

  const candidates = [...products.values()].filter((p) => {
    if (!validTypes.has(p.clean_product_type))               return false;
    // L1 guard: if we have L1 data for this product, it must match the slot's L1
    if (expectedL1 && p.category_l1 && p.category_l1 !== expectedL1) return false;
    if (p.orders_last_30d < MIN_L30D_ORDERS)                 return false;
    if (recentIds.has(p.customer_product_short_id))          return false;
    const price = p.reseller_selling_price || 0;
    if (price < band.min || price > band.max)                return false;
    return true;
  });

  if (!candidates.length) return [];

  // Signals — all normalised 0→1
  const normOrders    = normalise(candidates.map((p) => p.orders_last_30d));
  const normPPO       = normalise(candidates.map((p) => p.ppo_last_7d));
  const normShares    = normalise(candidates.map((p) => p.shares_last_7d));
  const normMargin    = normalise(candidates.map((p) => p.margin || 0));
  const normExclusive = candidates.map((p) => (p.exclusive ? 1 : 0)); // already 0/1
  const normMktGap    = normalise(candidates.map((p) => p.marketplace_gap || 0));

  const scored = candidates.map((p, i) => ({
    ...p,
    _score:
      (weights.l30d_orders     || 0.40) * normOrders[i]    +
      (weights.margin          || 0.25) * normMargin[i]    +
      (weights.l7d_views       || 0.20) * normPPO[i]       +
      (weights.l7d_shares      || 0.15) * normShares[i]    +
      (weights.exclusive       || 0.00) * normExclusive[i] +
      (weights.marketplace_gap || 0.00) * normMktGap[i],
  }));

  scored.sort((a, b) => b._score - a._score);
  return scored;
}

// Pick products for a slot, grouped by same sub-category.
// poolSize controls how many candidates to return from the best group —
// caller uses a larger pool so it can replace products whose images fail.
export async function pickSlotProducts(slot, poolSize = PRODUCTS_PER_SHARE) {
  const n      = PRODUCTS_PER_SHARE;
  let ranked   = await getRankedForSlot(slot);

  // AOV fallback: if nothing passes the price band, retry with no AOV restriction
  if (!ranked.length && slot.aovBucket !== "any") {
    console.log(`[Ranking] ${slot.category}-${slot.aovBucket}: no products in AOV band — retrying without AOV filter`);
    ranked = await getRankedForSlot({ ...slot, aovBucket: "any" });
  }

  if (!ranked.length) return [];

  const subPerf  = loadSubcategoryPerf();
  const validTypes = new Set(CATEGORY_TYPES[slot.category] || []);
  const catAvg   = categoryAvgOrders(subPerf, validTypes);

  // Group by sub-category
  const groups = new Map();
  for (const p of ranked) {
    const sc = p.clean_product_type;
    if (!groups.has(sc)) groups.set(sc, []);
    groups.get(sc).push(p);
  }

  // Best group: sum of top-N product scores × historical performance boost
  let bestKey      = null;
  let bestEffScore = -Infinity;

  for (const [sc, group] of groups) {
    const rawScore  = group.slice(0, n).reduce((s, p) => s + p._score, 0);
    const boost     = subcatBoost(subPerf, sc, catAvg);
    const effScore  = rawScore * boost;
    if (effScore > bestEffScore) { bestEffScore = effScore; bestKey = sc; }
  }

  const best = groups.get(bestKey) || [];
  if (!best.length) return [];
  return best.slice(0, poolSize);
}
