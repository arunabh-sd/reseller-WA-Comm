import { getProductMap } from "./cache.js";
import { CATEGORY_TYPES } from "./config/categories.js";
import { AOV_BUCKETS, MIN_L30D_ORDERS, PRODUCTS_PER_SHARE } from "./config/schedule.js";
import { getRecentlyShared } from "./history.js";
import { loadWeights } from "./learning.js";

function normalise(arr) {
  const max = Math.max(...arr, 1);
  return arr.map((v) => v / max);
}

export async function getRankedForSlot({ category, aovBucket }) {
  const weights   = loadWeights();
  const recentIds = getRecentlyShared();
  const products  = await getProductMap();

  const validTypes = new Set(CATEGORY_TYPES[category] || []);
  const band       = AOV_BUCKETS[aovBucket] || AOV_BUCKETS.any;

  const candidates = [...products.values()].filter((p) => {
    if (!validTypes.has(p.clean_product_type))               return false;
    if (p.orders_last_30d < MIN_L30D_ORDERS)                 return false;
    if (recentIds.has(p.customer_product_short_id))          return false;
    const price = p.reseller_selling_price || 0;
    if (price < band.min || price > band.max)                return false;
    return true;
  });

  if (!candidates.length) return [];

  const normOrders = normalise(candidates.map((p) => p.orders_last_30d));
  const normPPO    = normalise(candidates.map((p) => p.ppo_last_7d));
  const normShares = normalise(candidates.map((p) => p.shares_last_7d));

  const scored = candidates.map((p, i) => ({
    ...p,
    _score:
      weights.l30d_orders * normOrders[i] +
      weights.l7d_views   * normPPO[i]    +
      weights.l7d_shares  * normShares[i],
  }));

  scored.sort((a, b) => b._score - a._score);
  return scored;
}

// Pick N products for a slot, grouped by same sub-category where possible
export async function pickSlotProducts(slot) {
  const n      = PRODUCTS_PER_SHARE;
  const ranked = await getRankedForSlot(slot);
  if (!ranked.length) return [];

  // Group by sub-category
  const groups = new Map();
  for (const p of ranked) {
    const sc = p.clean_product_type;
    if (!groups.has(sc)) groups.set(sc, []);
    groups.get(sc).push(p);
  }

  // Best sub-category: highest sum of scores (proxy for group quality)
  let best = [];
  for (const group of groups.values()) {
    const groupScore = group.slice(0, n).reduce((s, p) => s + p._score, 0);
    const bestScore  = best.slice(0, n).reduce((s, p) => s + p._score, 0);
    if (groupScore > bestScore) best = group;
  }

  // Never mix sub-categories — take however many the best group has (min 2)
  if (best.length < 2) return [];
  return best.slice(0, n);
}
