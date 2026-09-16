import "dotenv/config";
import client from "./client/whatsapp.js";
import { startQRServer } from "./server.js";
import { startScheduler } from "./scheduler.js";
import { warmCache } from "./cache.js";
import { loadPending, applyPending, TEST_GROUP_JID } from "./pending_changes.js";
import { isNudgeJid, handleNudgeReply, resolveContactJids } from "./nudge.js";
import { pollCommunityMembers, handleWelcomeReply } from "./community.js";

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err?.message || err);
});

async function main() {
  console.log("Starting Reseller WA Community broadcaster…");

  startQRServer();
  await client.connect();

  // Message router
  client.on("message", async ({ jid, text }) => {
    // Nudge DM conversations
    if (isNudgeJid(jid)) {
      handleNudgeReply(jid, text).catch(e => console.error("[Nudge] Reply handler error:", e.message));
      return;
    }

    // Test group — "Yes" applies pending weight changes
    if (jid === TEST_GROUP_JID) {
      if (text.toLowerCase() !== "yes") return;
      const pending = loadPending();
      if (!pending) return;
      try { await applyPending(client); }
      catch (err) { console.error("[Pending] Apply failed:", err.message); }
      return;
    }

    // Ignore other group messages
    if (jid.endsWith("@g.us")) return;

    // Any individual DM → welcome / support chatbot
    handleWelcomeReply(jid, text).catch(e => console.error("[Community] Welcome reply error:", e.message));
  });

  client.once("ready", () => {
    startScheduler();
    warmCache().catch((e) => console.error("[cache] Warm failed:", e?.message));
    resolveContactJids(client.sock).catch((e) => console.error("[Nudge] JID resolve failed:", e.message));
    // Initial snapshot — subsequent polls (every 30 min) will diff against this
    pollCommunityMembers().catch((e) => console.error("[Community] Initial poll failed:", e.message));
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
