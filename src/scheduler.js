import cron from "node-cron";
import { DAILY_SLOTS } from "./config/schedule.js";
import { sendSlot } from "./sender.js";
import { runDailyLearning } from "./learning.js";

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

  // Daily learning — 8:30am IST
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
    (s) => `${s.hour}:${String(s.minute).padStart(2, "0")} ${s.category}`
  ).join(" · ");
  console.log(`Scheduler started — slots: ${slotSummary}`);
}
