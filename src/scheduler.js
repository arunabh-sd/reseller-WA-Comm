import cron from "node-cron";
import { DAILY_SLOTS } from "./config/schedule.js";
import { sendSlot } from "./sender.js";
import { runDailyLearning } from "./learning.js";

export function startScheduler() {
  // One cron job per slot
  for (const slot of DAILY_SLOTS) {
    cron.schedule(
      `0 ${slot.hour} * * *`,
      async () => {
        const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
        console.log(`[Scheduler] ${now} → ${slot.category} (${slot.aovBucket} AOV)`);
        try {
          await sendSlot(slot);
        } catch (err) {
          console.error(`[Scheduler] Slot ${slot.hour}h failed:`, err.message);
        }
      },
      { timezone: "Asia/Kolkata" }
    );
  }

  // Daily learning — 8:30am IST (after the 9am slot data would be fresh)
  cron.schedule(
    "30 8 * * *",
    async () => {
      try {
        await runDailyLearning();
      } catch (err) {
        console.error("[Learning] Daily run failed:", err.message);
      }
    },
    { timezone: "Asia/Kolkata" }
  );

  const slotSummary = DAILY_SLOTS.map(
    (s) => `${s.hour}:00 ${s.category}`
  ).join(" · ");
  console.log(`Scheduler started — slots: ${slotSummary}`);
}
