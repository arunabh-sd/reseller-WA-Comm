import axios from "axios";

const MB_URL = process.env.METABASE_URL || "https://metabase.kaip.in";
const MB_KEY = process.env.METABASE_API_KEY;

const mb = axios.create({
  baseURL: MB_URL,
  timeout: 120000,
  headers: { "x-api-key": MB_KEY },
});

async function runCard(cardId) {
  const { data } = await mb.post(`/api/card/${cardId}/query/json`, {});
  return Array.isArray(data) ? data : [];
}

// Card 14878 — primary product feed (per SKU)
// Columns: seller_id, seller_name, customer_product_short_id, customer_sku_short_id,
//          product_name, img_link, website_product_link, website_price,
//          transfer_price, reseller_selling_price_prepaid, cod_charge,
//          mp_price, mp_name, mp_link, cheapest_non_meesho_price, marketplace_count,
//          cheapest, exclusive, orders_last_30d, ppo_last_7d, shares_last_7d
export async function fetchPrimaryFeed() {
  const id = parseInt(process.env.METABASE_PRODUCT_QUESTION_ID || "14878");
  return runCard(id);
}

// Card 13784 — category, description, MRP, sizes (per SKU)
// Columns: customer_product_short_id, cust_sku_short_id, clean_product_type,
//          sharable_desc, size, mrp, reseller_selling_price, seller_id ...
export async function fetchCatalogueMeta() {
  return runCard(13784);
}

// Card 14565 — lifetime signals fallback
export async function fetchProductSignals() {
  return runCard(14565);
}

// Card 14915 — day-range performance (orders, PPO, shares) for ALL products
// Requires start_date and end_date (YYYY-MM-DD)
// Logs column names on every call so we can debug field mismatches in Railway logs
export async function fetchPerformanceForDate(dateStr) {
  const { data } = await mb.post(`/api/card/14915/query/json`, {
    parameters: [
      { type: "date/single", target: ["variable", ["template-tag", "start_date"]], value: dateStr },
      { type: "date/single", target: ["variable", ["template-tag", "end_date"]],   value: dateStr },
    ],
  });
  const rows = Array.isArray(data) ? data : [];
  if (rows.length) {
    console.log(`[14915] ${rows.length} rows | columns: ${Object.keys(rows[0]).join(", ")}`);
    console.log(`[14915] sample:`, JSON.stringify(rows[0]));
  } else {
    console.warn(`[14915] No rows returned for ${dateStr}`);
  }
  return rows;
}

// Card 13897 — today's order totals (total_orders, new/repeat orderers)
// Has a manual date filter — we pass today's IST date
// Check your Metabase card for the exact template-tag name; default assumed is "date"
const ORDERS_DATE_TAG = process.env.ORDERS_DATE_TAG || "date";

export async function fetchTodayOrders() {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
  try {
    const { data } = await mb.post(`/api/card/13897/query/json`, {
      parameters: [
        { type: "date/single", target: ["variable", ["template-tag", ORDERS_DATE_TAG]], value: today },
      ],
    });
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) return null;
    // Log columns once per process run (will repeat across restarts — intentional)
    if (!fetchTodayOrders._logged) {
      console.log(`[13897] columns: ${Object.keys(rows[0]).join(", ")}`);
      fetchTodayOrders._logged = true;
    }
    const row = rows[0];
    // Try known field name variants
    const pick = (row, ...keys) => {
      for (const k of keys) if (row[k] != null) return Number(row[k]) || 0;
      return 0;
    };
    return {
      total_orders:    pick(row, "total_orders",    "Total Orders",    "orders"),
      new_orderers:    pick(row, "new_orderers",    "New Orderers",    "new_customers",    "new"),
      repeat_orderers: pick(row, "repeat_orderers", "Repeat Orderers", "repeat_customers", "repeat"),
    };
  } catch (err) {
    console.error("[Orders] Card 13897 failed:", err.message);
    return null;
  }
}
