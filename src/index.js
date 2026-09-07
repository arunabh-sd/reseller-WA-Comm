import "dotenv/config";
import client from "./client/whatsapp.js";
import { startQRServer } from "./server.js";
import { startScheduler } from "./scheduler.js";

async function main() {
  console.log("Starting Reseller WA Community broadcaster…");

  // Start QR/health HTTP server (Railway needs a port listener)
  startQRServer();

  // Connect WhatsApp
  await client.connect();

  client.once("ready", () => {
    startScheduler();
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
