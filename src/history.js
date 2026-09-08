import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR  = process.env.DATA_DIR || "data";
const FILE      = join(DATA_DIR, "shared_history.json");
const NO_REPEAT_DAYS = 30;

function ensureDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}

function save(entries) {
  ensureDir();
  writeFileSync(FILE, JSON.stringify(entries, null, 2));
}

// Returns Set of product_ids sent in last NO_REPEAT_DAYS days
export function getRecentlyShared() {
  const cutoff = Date.now() - NO_REPEAT_DAYS * 24 * 60 * 60 * 1000;
  const entries = load();
  return new Set(
    entries
      .filter((e) => new Date(e.sent_at).getTime() > cutoff)
      .map((e) => e.product_id)
  );
}

// Record a batch of products sent in one slot
export function recordShared(products, slotMeta) {
  ensureDir();
  const entries = load();
  const now = new Date().toISOString();

  for (const p of products) {
    entries.push({
      product_id:      p.customer_product_short_id,
      product_name:    p.product_name || "",
      category:        slotMeta.category,
      sub_category:    p.clean_product_type,
      aov_bucket:      slotMeta.aovBucket,
      price:           p.reseller_selling_price || 0,
      margin:          p.margin || 0,
      marketplace_gap: p.marketplace_gap || 0,
      exclusive:       Boolean(p.exclusive),
      sent_at:         now,
      slot_hour:       slotMeta.hour,
    });
  }

  save(entries);
}

// For the learning module: return entries sent on a given date (YYYY-MM-DD IST)
export function getSharedOnDate(dateStr) {
  const entries = load();
  return entries.filter((e) => e.sent_at.startsWith(dateStr));
}

export function getAllHistory() {
  return load();
}
