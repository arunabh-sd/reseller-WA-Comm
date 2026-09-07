import axios from "axios";

const MB_URL = process.env.METABASE_URL || "https://metabase.kaip.in";
const MB_KEY = process.env.METABASE_API_KEY;

const mb = axios.create({
  baseURL: MB_URL,
  timeout: 30000,
  headers: { "x-api-key": MB_KEY },
});

async function runCard(cardId, params = {}) {
  const { data } = await mb.post(
    `/api/card/${cardId}/query/json`,
    Object.keys(params).length ? { parameters: params } : {}
  );
  return Array.isArray(data) ? data : [];
}

// ── Product performance signals (existing card 14565) ─────────────────────────
// Returns: { customer_product_short_id, lifetime_orders, product_views,
//            product_shares, reseller_orders }
// TODO: replace with user's custom question ID once shared
export async function fetchProductSignals() {
  const CARD_ID = parseInt(process.env.METABASE_SIGNALS_QUESTION_ID || "14565");
  return runCard(CARD_ID);
}

// ── Product catalogue with categories (existing card 13784) ───────────────────
// Returns: { customer_product_short_id, clean_product_type, sharable_desc,
//            mrp, reseller_selling_price, seller_name, ... }
// TODO: user's custom question will also include image_url and L30D orders —
//       replace METABASE_CATALOGUE_QUESTION_ID once shared
export async function fetchProductCatalogue() {
  const CARD_ID = parseInt(process.env.METABASE_CATALOGUE_QUESTION_ID || "13784");
  return runCard(CARD_ID);
}

// ── User's custom questions (plug in once IDs are shared) ─────────────────────
// Expected columns: customer_product_short_id, image_url, l30d_orders, l7d_views, l7d_shares
export async function fetchCustomProductData() {
  const CARD_ID = process.env.METABASE_PRODUCT_QUESTION_ID;
  if (!CARD_ID) return [];
  return runCard(parseInt(CARD_ID));
}

// ── Yesterday's share performance (for daily learning) ────────────────────────
// Pulls reseller_orders and shares for specific product IDs shared yesterday
export async function fetchProductPerformance(productIds) {
  if (!productIds.length) return [];
  const CARD_ID = process.env.METABASE_PERFORMANCE_QUESTION_ID;
  if (!CARD_ID) {
    // Fallback: use signals card and filter
    const all = await fetchProductSignals();
    const ids = new Set(productIds);
    return all.filter((r) => ids.has(r.customer_product_short_id));
  }
  return runCard(parseInt(CARD_ID));
}
