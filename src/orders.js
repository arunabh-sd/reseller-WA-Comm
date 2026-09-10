import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import client from "./client/whatsapp.js";
import { fetchTodayOrders } from "./metabase.js";
import { TEST_GROUP_JID } from "./pending_changes.js";

const DATA_DIR   = process.env.DATA_DIR || "data";
const STATE_FILE = join(DATA_DIR, "order_state.json");

function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // "YYYY-MM-DD"
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return null; }
}

function saveState(data) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function checkOrders() {
  if (!client.isReady) return;

  const today   = todayIST();
  const current = await fetchTodayOrders();
  if (!current) return;

  const state = loadState();

  // First poll of the day (or new day): set baseline without sending anything
  if (!state || state.date !== today) {
    saveState({ date: today, ...current });
    return;
  }

  const delta       = current.total_orders    - state.total_orders;
  const newDelta    = (current.new_orderers    || 0) - (state.new_orderers    || 0);
  const repeatDelta = (current.repeat_orderers || 0) - (state.repeat_orderers || 0);

  if (delta <= 0) {
    saveState({ date: today, ...current });
    return;
  }

  // Cap individual notifications at 3; summarise if more came in at once
  if (delta > 3) {
    await client.sendTextMessage(
      TEST_GROUP_JID,
      `🛒 *${delta} orders just came in!*\n` +
      `*Today's total:* ${current.total_orders} orders\n` +
      `${newDelta > 0 ? `${newDelta} new` : ""}${newDelta > 0 && repeatDelta > 0 ? " · " : ""}${repeatDelta > 0 ? `${repeatDelta} repeat` : ""} customers`.trim()
    );
  } else {
    let newSent = 0;
    for (let i = 0; i < delta; i++) {
      const isNew  = newSent < newDelta;
      if (isNew) newSent++;
      const total  = state.total_orders + i + 1;
      await client.sendTextMessage(
        TEST_GROUP_JID,
        `🛒 *Just got an order!*\n` +
        `*${isNew ? "New" : "Repeat"} Customer*\n` +
        `*Today's total:* ${total} orders`
      );
      if (i < delta - 1) await sleep(2000);
    }
  }

  saveState({ date: today, ...current });
  console.log(`[Orders] +${delta} new orders | total today: ${current.total_orders}`);
}
