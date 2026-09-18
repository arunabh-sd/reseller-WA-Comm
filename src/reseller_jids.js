import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = process.env.DATA_DIR || "data";
const FILE     = join(DATA_DIR, "reseller_jids.json");

function load() {
  try { return JSON.parse(readFileSync(FILE, "utf8")); }
  catch { return {}; }
}

function save(data) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(data, null, 2));
}

// Metabase returns phone as float: "919039123954.0" → "919039123954"
export function cleanPhone(raw) {
  return String(raw).replace(/\.0$/, "").trim();
}

// Returns stored JID or null
export function getJid(phone) {
  const p = cleanPhone(phone);
  return load()[p]?.jid || null;
}

// Default @s.whatsapp.net JID — used until first successful send confirms real JID
export function getDefaultJid(phone) {
  return `${cleanPhone(phone)}@s.whatsapp.net`;
}

// Store or update a JID for a phone. meta can include { name, reseller_id }.
// Returns true if this is a first-time store.
export function storeJid(phone, jid, meta = {}) {
  const p     = cleanPhone(phone);
  const store = load();
  if (!store[p]) {
    store[p] = { jid, discovered_at: new Date().toISOString(), ...meta };
    save(store);
    return true;
  }
  if (store[p].jid !== jid) {
    store[p].jid        = jid;
    store[p].updated_at = new Date().toISOString();
    save(store);
  }
  return false;
}

export function getAllJids() {
  return load();
}
