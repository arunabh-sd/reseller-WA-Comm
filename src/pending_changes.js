import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";

const DATA_DIR    = process.env.DATA_DIR || "data";
const PENDING_FILE = join(DATA_DIR, "pending_changes.json");
const WEIGHTS_FILE = join(DATA_DIR, "weights.json");

export const TEST_GROUP_JID = "120363431273030908@g.us";

// Pending expires after 20 hours — stale recommendations don't get applied days later
const MAX_AGE_MS = 20 * 60 * 60 * 1000;

export function savePending(data) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PENDING_FILE, JSON.stringify({ ...data, generated_at: new Date().toISOString() }, null, 2));
}

export function loadPending() {
  try {
    const data = JSON.parse(readFileSync(PENDING_FILE, "utf8"));
    if (Date.now() - new Date(data.generated_at).getTime() > MAX_AGE_MS) {
      unlinkSync(PENDING_FILE);
      return null;
    }
    return data;
  } catch { return null; }
}

export function clearPending() {
  try { unlinkSync(PENDING_FILE); } catch {}
}

export async function applyPending(client) {
  const pending = loadPending();
  if (!pending?.weights) {
    await client.sendTextMessage(TEST_GROUP_JID, "No pending changes (or they expired after 20h).");
    return;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(WEIGHTS_FILE, JSON.stringify(pending.weights, null, 2));
  clearPending();

  const lines = Object.entries(pending.weights)
    .map(([k, v]) => `• ${k}: ${v.toFixed(4)}`)
    .join("\n");
  await client.sendTextMessage(TEST_GROUP_JID, `✅ *Weights applied!*\n\n${lines}`);
  console.log("[Pending] Weights applied:", pending.weights);
}
