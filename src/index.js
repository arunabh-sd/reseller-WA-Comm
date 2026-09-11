import "dotenv/config";
import client from "./client/whatsapp.js";
import { startQRServer } from "./server.js";
import { startScheduler } from "./scheduler.js";
import { warmCache } from "./cache.js";
import { loadPending, applyPending, TEST_GROUP_JID } from "./pending_changes.js";
import { isNudgeJid, handleNudgeReply } from "./nudge.js";

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err?.message || err);
});

async function main() {
  console.log("Starting Reseller WA Community broadcaster…");

  startQRServer();
  await client.connect();

  // Message router
  client.on("message", async ({ jid, text }) => {
    console.log(`[MSG] from=${jid} nudgeActive=${isNudgeJid(jid)} text="${text.slice(0, 40)}"`);
    // Nudge conversation replies (individual contacts)
    if (isNudgeJid(jid)) {
      handleNudgeReply(jid, text).catch(e => console.error("[Nudge] Reply handler error:", e.message));
      return;
    }

    // "Yes" listener — applies pending AI-recommended weight changes
    if (jid !== TEST_GROUP_JID) return;
    if (text.toLowerCase() !== "yes") return;
    const pending = loadPending();
    if (!pending) return;
    try {
      await applyPending(client);
    } catch (err) {
      console.error("[Pending] Apply failed:", err.message);
    }
  });

  client.once("ready", () => {
    startScheduler();
    warmCache().catch((e) => console.error("[cache] Warm failed:", e?.message));
  });

  client.once("logged_out", () => {
    console.error("WhatsApp logged out — restart and rescan QR");
    process.exit(1);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
