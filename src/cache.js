import { fetchPrimaryFeed, fetchCatalogueMeta } from "./metabase.js";

const REFRESH_MS = 2 * 60 * 60 * 1000; // 2 hours

function toSlug(name) {
  return name.trim().replace(/[^a-zA-Z0-9\s-]/g, "").replace(/\s+/g, "-");
}

function buildMap(feed, meta) {
  const metaByProduct = new Map();
  const sizesByProduct = new Map();

  for (const row of meta) {
    const id = row.customer_product_short_id;
    if (!metaByProduct.has(id)) {
      metaByProduct.set(id, row);
      sizesByProduct.set(id, new Set());
    }
    if (row.size && row.size !== "OneSize") sizesByProduct.get(id).add(row.size);
  }

  const productMap = new Map();
  for (const row of feed) {
    const id = row.customer_product_short_id;
    if (productMap.has(id)) continue;
    const m     = metaByProduct.get(id) || {};
    const sizes = [...(sizesByProduct.get(id) || [])];
    productMap.set(id, {
      customer_product_short_id: id,
      customer_sku_short_id:     row.customer_sku_short_id,
      product_name:              row.product_name,
      sharable_desc:             m.sharable_desc || "",
      img_link:                  row.img_link || "",
      qrate_url:                 `https://qrate.shopdeck.com/${toSlug(row.product_name)}/catalogue/${id}/${row.customer_sku_short_id}`,
      sizes:                     sizes.length ? sizes.join(", ") : null,
      mrp:                       m.mrp || null,
      reseller_selling_price:    row.reseller_selling_price_prepaid,
      cod_charge:                row.cod_charge || 0,
      transfer_price:            row.transfer_price,
      mp_price:                  row.mp_price,
      mp_name:                   row.mp_name,
      mp_link:                   row.mp_link,
      website_price:             row.website_price,
      website_product_link:      row.website_product_link,
      cheapest:                  row.cheapest,
      exclusive:                 row.exclusive,
      clean_product_type:        m.clean_product_type || "",
      orders_last_30d:           row.orders_last_30d  || 0,
      ppo_last_7d:               row.ppo_last_7d      || 0,
      shares_last_7d:            row.shares_last_7d   || 0,
    });
  }
  return productMap;
}

let _cache = null;
let _fetchedAt = 0;
let _inflight = null;

async function refresh() {
  console.log("[cache] Fetching product data from Metabase…");
  const [feed, meta] = await Promise.all([fetchPrimaryFeed(), fetchCatalogueMeta()]);
  _cache = buildMap(feed, meta);
  _fetchedAt = Date.now();
  console.log(`[cache] Loaded ${_cache.size} products`);
  return _cache;
}

export async function getProductMap() {
  if (_cache && Date.now() - _fetchedAt < REFRESH_MS) return _cache;
  if (_inflight) return _inflight; // deduplicate concurrent callers
  _inflight = refresh().finally(() => { _inflight = null; });
  return _inflight;
}

// Call this at startup to pre-warm before first slot fires
export async function warmCache() {
  return getProductMap();
}
