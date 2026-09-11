import cron from "node-cron";
import { DAILY_SLOTS } from "./config/schedule.js";
import { sendSlot } from "./sender.js";
import { runDailyLearning } from "./learning.js";
import { checkOrders } from "./orders.js";
import { startNudgeCampaign } from "./nudge.js";
import { warmCache } from "./cache.js";
import client from "./client/whatsapp.js";

export function startScheduler() {
  for (const slot of DAILY_SLOTS) {
    cron.schedule(
      `${slot.minute} ${slot.hour} * * *`,
      async () => {
        const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
        console.log(`[Scheduler] ${now} → ${slot.category} (${slot.aovBucket} AOV)`);
        try {
          await sendSlot(slot);
        } catch (err) {
          console.error(`[Scheduler] Slot ${slot.hour}:${String(slot.minute).padStart(2,"0")} failed:`, err.message);
        }
      },
      { timezone: "Asia/Kolkata" }
    );
  }

  // Daily cache refresh — 5:45am IST (fresh data before first slot)
  cron.schedule(
    "45 5 * * *",
    () => warmCache().catch(e => console.error("[cache] Daily refresh failed:", e.message)),
    { timezone: "Asia/Kolkata" }
  );

  // Daily learning — 8:45am IST (before 9am slots fire)
  cron.schedule(
    "45 8 * * *",
    async () => {
      try {
        await runDailyLearning(client);
      } catch (err) {
        console.error("[Learning] Daily run failed:", err.message);
      }
    },
    { timezone: "Asia/Kolkata" }
  );

  // Order polling — every 5 minutes during business hours (8am–11pm IST)
  cron.schedule(
    "*/5 8-23 * * *",
    async () => {
      try { await checkOrders(); }
      catch (err) { console.error("[Orders] Poll failed:", err.message); }
    },
    { timezone: "Asia/Kolkata" }
  );

  // Daily nudge campaign — 11am IST
  // Also fires immediately on startup (once per IST day, deduped)
  let nudgeFiredDate = null;

  async function runNudge() {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (nudgeFiredDate === today) return;
    nudgeFiredDate = today;
    try {
      await startNudgeCampaign();
    } catch (err) {
      console.error("[Nudge] Campaign failed:", err.message);
    }
  }

  cron.schedule("0 11 * * *", runNudge, { timezone: "Asia/Kolkata" });

  // Fire immediately on startup — covers initial deployment + any restart before 11am
  setTimeout(() => runNudge(), 5000);

  const slotSummary = DAILY_SLOTS.map(
    (s) => `${s.hour}:${String(s.minute).padStart(2, "0")} ${s.category}`
  ).join(" · ");
  console.log(`Scheduler started — slots: ${slotSummary}`);
}
