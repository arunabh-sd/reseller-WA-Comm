import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = process.env.DATA_DIR || "data";
const DIR      = join(DATA_DIR, "reseller_shared");

function filePath(resellerId) {
  return join(DIR, `${resellerId}.json`);
}

function load(resellerId) {
  try { return JSON.parse(readFileSync(filePath(resellerId), "utf8")); }
  catch { return []; }
}

// Returns Set of product IDs ever sent to this reseller by our bot
export function getSharedForReseller(resellerId) {
  return new Set(load(resellerId).map(e => e.product_id));
}

// Record which products we just sent to this reseller
export function recordSharedForReseller(resellerId, productIds) {
  mkdirSync(DIR, { recursive: true });
  const entries = load(resellerId);
  const now = new Date().toISOString();
  for (const id of productIds) {
    entries.push({ product_id: id, sent_at: now });
  }
  writeFileSync(filePath(resellerId), JSON.stringify(entries, null, 2));
}

// All entries for a reseller (for debugging / admin)
export function getAllSharedForReseller(resellerId) {
  return load(resellerId);
}
