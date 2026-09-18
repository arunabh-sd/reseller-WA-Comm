import { getProductMap } from "./cache.js";
import { CATEGORY_TYPES } from "./config/categories.js";
import { MIN_L30D_ORDERS, PRODUCTS_PER_SHARE } from "./config/schedule.js";
import { getRecentlyShared } from "./history.js";
import { loadWeights, loadSubcategoryPerf } from "./learning.js";

// Maps slot category names → category_l1 strings from product_labels.json.
// Only set where L1 data adds filtering value; new specific-subcategory slots
// are narrow enough via CATEGORY_TYPES alone and don't need an L1 guard.
const CATEGORY_L1_MAP = {
  kurti:    "Kurtas, Kurtis & Sets",
  saree:    "Sarees",
  coord:    "Western Wear",
  handbag:  "Bags",
};

// Exclude products explicitly marketed to men/boys — catches mismapped types
// and cross-gender products where the name makes it clear. Word-boundary match
// so "women", "element", "female" are not caught.
const MALE_NAME_PATTERN = /\b(men|mens|men's|boys|boy's|gents|male|unisex\s+men)\b/i;

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

export async function getRankedForSlot({ category }) {
  const weights   = loadWeights();
  const recentIds = getRecentlyShared();
  const products  = await getProductMap();

  const validTypes = new Set(CATEGORY_TYPES[category] || []);
  const expectedL1 = CATEGORY_L1_MAP[category];

  const candidates = [...products.values()].filter((p) => {
    if (!validTypes.has(p.clean_product_type))                        return false;
    // L1 guard: only applies for categories that have an L1 entry
    if (expectedL1 && p.category_l1 && p.category_l1 !== expectedL1) return false;
    if (p.orders_last_30d < MIN_L30D_ORDERS)                         return false;
    if (recentIds.has(p.customer_product_short_id))                   return false;
    // Drop anything explicitly marketed to men/boys — catches mismapped types
    if (MALE_NAME_PATTERN.test(p.product_name))                       return false;
    return true;
  });

  if (!candidates.length) return [];

  // Signals — all normalised 0→1
  // Priority: 40% reseller L30d orders, 30% overall L30d orders, 15% L7d shares, 15% margin
  const normResellerOrders = normalise(candidates.map((p) => p.reseller_orders_last_30d || 0));
  const normOrders         = normalise(candidates.map((p) => p.orders_last_30d));
  const normShares         = normalise(candidates.map((p) => p.shares_last_7d));
  const normMargin         = normalise(candidates.map((p) => p.margin || 0));

  const scored = candidates.map((p, i) => ({
    ...p,
    _score:
      (weights.reseller_orders_l30d || 0.40) * normResellerOrders[i] +
      (weights.l30d_orders          || 0.30) * normOrders[i]         +
      (weights.l7d_shares           || 0.15) * normShares[i]         +
      (weights.margin               || 0.15) * normMargin[i],
  }));

  scored.sort((a, b) => b._score - a._score);
  return scored;
}

// Pick products for a slot, grouped by same sub-category.
// poolSize controls how many candidates to return from the best group —
// caller uses a larger pool so it can replace products whose images fail.
export async function pickSlotProducts(slot, poolSize = PRODUCTS_PER_SHARE) {
  const n      = PRODUCTS_PER_SHARE;
  const ranked = await getRankedForSlot(slot);

  if (!ranked.length) return [];

  const subPerf    = loadSubcategoryPerf();
  const validTypes = new Set(CATEGORY_TYPES[slot.category] || []);
  const catAvg     = categoryAvgOrders(subPerf, validTypes);

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
    const rawScore = group.slice(0, n).reduce((s, p) => s + p._score, 0);
    const boost    = subcatBoost(subPerf, sc, catAvg);
    const effScore = rawScore * boost;
    if (effScore > bestEffScore) { bestEffScore = effScore; bestKey = sc; }
  }

  const best = groups.get(bestKey) || [];
  if (!best.length) return [];
  return best.slice(0, poolSize);
}
