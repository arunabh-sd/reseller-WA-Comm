import { fetchPrimaryFeed, fetchCatalogueMeta } from "./metabase.js";
import { CATEGORY_TYPES } from "./config/categories.js";
import { AOV_BUCKETS, MIN_L30D_ORDERS, PRODUCTS_PER_SHARE } from "./config/schedule.js";
import { getRecentlyShared } from "./history.js";
import { loadWeights } from "./learning.js";

// Build slug for qrate URL from product name
function toSlug(name) {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
}

// Merge primary feed (14878) + catalogue meta (13784) into one product map
// Groups per product (not per SKU), aggregates sizes
async function buildProductMap() {
  const [feed, meta] = await Promise.all([fetchPrimaryFeed(), fetchCatalogueMeta()]);

  // Index meta by product_id for fast lookup
  // Also build sizes map: product_id → Set of size strings
  const metaByProduct = new Map();
  const sizesByProduct = new Map();

  for (const row of meta) {
    const id = row.customer_product_short_id;
    if (!metaByProduct.has(id)) {
      metaByProduct.set(id, row);
      sizesByProduct.set(id, new Set());
    }
    if (row.size && row.size !== "OneSize") {
      sizesByProduct.get(id).add(row.size);
    }
  }

  // Group primary feed by product_id — pick the first SKU row as representative
  const productMap = new Map();
  for (const row of feed) {
    const id = row.customer_product_short_id;
    if (productMap.has(id)) continue; // first SKU wins

    const m     = metaByProduct.get(id) || {};
    const sizes = [...(sizesByProduct.get(id) || [])];

    const qrateUrl = `https://qrate.shopdeck.com/${toSlug(row.product_name)}/catalogue/${id}/${row.customer_sku_short_id}`;

    productMap.set(id, {
      // Identity
      customer_product_short_id: id,
      customer_sku_short_id:     row.customer_sku_short_id,
      seller_id:                 row.seller_id,
      seller_name:               row.seller_name,

      // Display
      product_name:   row.product_name,
      sharable_desc:  m.sharable_desc || "",
      img_link:       row.img_link || "",
      qrate_url:      qrateUrl,
      sizes:          sizes.length ? sizes.join(", ") : null,

      // Pricing
      mrp:                           m.mrp || null,
      reseller_selling_price:        row.reseller_selling_price_prepaid,
      cod_charge:                    row.cod_charge || 0,
      transfer_price:                row.transfer_price,

      // Marketplace comparisons
      mp_price:   row.mp_price,
      mp_name:    row.mp_name,
      mp_link:    row.mp_link,
      website_price:        row.website_price,
      website_product_link: row.website_product_link,
      cheapest:   row.cheapest,
      exclusive:  row.exclusive,

      // Category
      clean_product_type: m.clean_product_type || "",

      // Ranking signals
      orders_last_30d: row.orders_last_30d  || 0,
      ppo_last_7d:     row.ppo_last_7d      || 0, // product page opens L7D
      shares_last_7d:  row.shares_last_7d   || 0,
    });
  }

  return productMap;
}

function normalise(arr) {
  const max = Math.max(...arr, 1);
  return arr.map((v) => v / max);
}

export async function getRankedForSlot({ category, aovBucket }) {
  const weights   = loadWeights();
  const recentIds = getRecentlyShared();
  const products  = await buildProductMap();

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

  // Fall back to top-N across all if no group big enough
  return (best.length >= n ? best : ranked).slice(0, n);
}
