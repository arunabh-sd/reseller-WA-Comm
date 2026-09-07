import { fetchProductSignals, fetchProductCatalogue, fetchCustomProductData } from "./metabase.js";
import { CATEGORY_TYPES, ALL_ACTIVE_TYPES } from "./config/categories.js";
import { AOV_BUCKETS, MIN_L30D_ORDERS } from "./config/schedule.js";
import { getRecentlyShared } from "./history.js";
import { loadWeights } from "./learning.js";

function normalise(values) {
  const max = Math.max(...values, 1);
  return values.map((v) => v / max);
}

// Build merged product map: product_id → full product object
async function buildProductMap() {
  const [catalogue, signals, custom] = await Promise.all([
    fetchProductCatalogue(),
    fetchProductSignals(),
    fetchCustomProductData(),
  ]);

  // Index signals and custom data by product_id
  const signalMap = Object.fromEntries(
    signals.map((r) => [r.customer_product_short_id, r])
  );
  const customMap = Object.fromEntries(
    custom.map((r) => [r.customer_product_short_id, r])
  );

  // Merge catalogue rows with signals
  const map = new Map();
  for (const row of catalogue) {
    const id = row.customer_product_short_id;
    if (!id || !ALL_ACTIVE_TYPES.has(row.clean_product_type)) continue;

    const sig = signalMap[id] || {};
    const cus = customMap[id] || {};

    map.set(id, {
      ...row,
      // Prefer custom question data when available
      image_url:            cus.image_url || null,
      l30d_orders:          cus.l30d_orders  ?? sig.july_orders       ?? 0,
      l7d_views:            cus.l7d_views    ?? sig.product_views      ?? 0,
      l7d_shares:           cus.l7d_shares   ?? sig.product_shares     ?? 0,
      reseller_orders:      cus.reseller_orders ?? sig.reseller_orders ?? 0,
      lifetime_orders:      sig.lifetime_orders ?? 0,
    });
  }

  return map;
}

// Score and rank products for a given slot
export async function getRankedForSlot({ category, aovBucket }) {
  const weights    = loadWeights();
  const recentIds  = getRecentlyShared();
  const productMap = await buildProductMap();

  const validTypes = CATEGORY_TYPES[category] || [];
  const priceBand  = AOV_BUCKETS[aovBucket] || AOV_BUCKETS.any;

  // Filter
  const candidates = [...productMap.values()].filter((p) => {
    if (!validTypes.includes(p.clean_product_type)) return false;
    if (p.l30d_orders < MIN_L30D_ORDERS)             return false; // not a bestseller
    if (recentIds.has(p.customer_product_short_id))  return false; // sent in last 30 days
    const price = p.reseller_selling_price || 0;
    if (price < priceBand.min || price > priceBand.max) return false;
    return true;
  });

  if (!candidates.length) return [];

  // Normalise signals
  const l30dVals   = candidates.map((p) => p.l30d_orders);
  const viewVals   = candidates.map((p) => p.l7d_views);
  const shareVals  = candidates.map((p) => p.l7d_shares);

  const normL30d   = normalise(l30dVals);
  const normViews  = normalise(viewVals);
  const normShares = normalise(shareVals);

  const scored = candidates.map((p, i) => ({
    ...p,
    _score:
      weights.l30d_orders  * normL30d[i]   +
      weights.l7d_views    * normViews[i]  +
      weights.l7d_shares   * normShares[i],
  }));

  // Sort descending
  scored.sort((a, b) => b._score - a._score);
  return scored;
}

// Pick N products for a slot, grouped by same sub-category where possible
export async function pickSlotProducts(slot, n = 4) {
  const ranked = await getRankedForSlot(slot);
  if (!ranked.length) return [];

  // Try to find N products of the same sub-category (top sub-cat wins)
  const subCatGroups = new Map();
  for (const p of ranked) {
    const sc = p.clean_product_type;
    if (!subCatGroups.has(sc)) subCatGroups.set(sc, []);
    subCatGroups.get(sc).push(p);
  }

  // Best sub-category = the one with most high-scoring products
  let bestGroup = [];
  for (const [, group] of subCatGroups) {
    if (group.length >= n && group.length > bestGroup.length) {
      bestGroup = group;
    }
  }

  // Fall back to top-N across all sub-cats if no single sub-cat has N
  if (bestGroup.length < n) {
    bestGroup = ranked;
  }

  return bestGroup.slice(0, n);
}
