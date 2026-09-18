import express from "express";
import QRCode from "qrcode";
import fs from "fs";
import client from "./client/whatsapp.js";
import { sendSlot } from "./sender.js";
import { DAILY_SLOTS } from "./config/schedule.js";
import { runResellerPlanner, loadTodayPlan } from "./reseller_planner.js";
import { sendDailyResellerCampaign, previewResellerSend } from "./reseller_sender.js";

const PORT = process.env.PORT || 3000;

export function startQRServer() {
  const app = express();

  // Health check (Railway uses this)
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // QR page — open this in browser to scan on first connect
  app.get("/qr", async (_req, res) => {
    if (client.isReady) {
      return res.send(`
        <html><body style="font-family:sans-serif;padding:40px;text-align:center">
          <h2 style="color:green">✓ WhatsApp is connected</h2>
          <p>No QR needed — broadcaster is running.</p>
        </body></html>
      `);
    }

    if (!client.latestQR) {
      return res.send(`
        <html><body style="font-family:sans-serif;padding:40px;text-align:center">
          <h2>Waiting for QR code…</h2>
          <p>Refresh in a few seconds.</p>
          <script>setTimeout(() => location.reload(), 3000)</script>
        </body></html>
      `);
    }

    try {
      const qrDataUrl = await QRCode.toDataURL(client.latestQR, { scale: 8 });
      res.send(`
        <html><body style="font-family:sans-serif;padding:40px;text-align:center">
          <h2>Scan this QR with WhatsApp</h2>
          <p>WhatsApp → Linked Devices → Link a Device</p>
          <img src="${qrDataUrl}" style="max-width:320px;border:1px solid #eee;border-radius:8px"/>
          <p style="color:#888;font-size:14px">Refreshes automatically once connected.</p>
          <script>setTimeout(() => location.reload(), 30000)</script>
        </body></html>
      `);
    } catch {
      res.status(500).send("Failed to render QR");
    }
  });

  // Debug — dump all groups/communities with key fields
  app.get("/debug/groups", async (_req, res) => {
    if (!client.isReady) return res.status(503).json({ error: "WhatsApp not connected" });
    const groups = await client.sock.groupFetchAllParticipating();
    const summary = Object.values(groups).map((g) => ({
      id:           g.id,
      subject:      g.subject,
      linkedParent: g.linkedParent || null,
      isParent:     g.isParent     || null,
      isCommunity:  g.isCommunity  || null,
    }));
    res.json(summary);
  });

  // Manual trigger — fire any slot immediately
  // Usage: /trigger?category=jewellery&aov=high
  //        /trigger?hour=19
  //        /trigger?category=kurti  (picks first matching)
  // Add &targets=communities to send to communities only (not focus group)
  app.get("/trigger", async (req, res) => {
    if (!client.isReady) return res.status(503).json({ error: "WhatsApp not connected" });

    const { category, aov, hour, targets } = req.query;
    let slot;

    if (category && aov) {
      slot = DAILY_SLOTS.find((s) => s.category === category && s.aovBucket === aov);
    } else if (hour) {
      slot = DAILY_SLOTS.find((s) => s.hour === parseInt(hour));
    } else if (category) {
      slot = DAILY_SLOTS.find((s) => s.category === category);
    } else {
      return res.status(400).json({ error: "Pass ?category=kurti&aov=high or ?hour=19", slots: DAILY_SLOTS });
    }

    if (!slot) return res.status(404).json({ error: "No matching slot found", slots: DAILY_SLOTS });

    const onlyCommunities = targets === "communities";
    const tag = `${slot.hour}:${String(slot.minute).padStart(2,"0")} ${slot.category} (${slot.aovBucket})`;
    res.json({ message: `Firing: ${tag}${onlyCommunities ? " — communities only" : ""}` });
    sendSlot(slot, onlyCommunities).catch((e) => console.error("[/trigger]", e));
  });

  // ── Acquired reseller endpoints ─────────────────────────────────────────────

  // Run (or view) today's reseller plan.
  // GET /reseller/plan          → returns cached plan if it exists
  // GET /reseller/plan?force=1  → regenerates even if plan exists today
  app.get("/reseller/plan", async (req, res) => {
    const existing = loadTodayPlan();
    if (existing && !req.query.force) {
      return res.json({ cached: true, resellers: existing.length, plan: existing });
    }
    res.json({ message: "Planning run started — check logs. Reload this URL in ~30s to see the plan." });
    runResellerPlanner().catch(e => console.error("[/reseller/plan]", e.message));
  });

  // Fire today's reseller send campaign immediately.
  // GET /reseller/send — generates plan if missing, then sends to all resellers
  app.get("/reseller/send", async (req, res) => {
    if (!client.isReady) return res.status(503).json({ error: "WhatsApp not connected" });
    res.json({ message: "Reseller campaign started — check Railway logs" });
    sendDailyResellerCampaign().catch(e => console.error("[/reseller/send]", e.message));
  });

  // Prevent double-fire on quick reloads (e.g. browser retry)
  let previewInFlight = false;

  // Preview: run plan for one reseller and send to Arunabh's test number.
  // GET /reseller/preview                     → uses first reseller in today's plan
  // GET /reseller/preview?phone=919039123954  → finds that reseller in the plan
  // Products are NOT recorded in reseller history (safe to call multiple times).
  app.get("/reseller/preview", async (req, res) => {
    if (!client.isReady) return res.status(503).json({ error: "WhatsApp not connected" });
    if (previewInFlight) return res.status(429).json({ error: "Preview already in progress — wait a minute" });

    const testPhone = process.env.PREVIEW_TEST_PHONE || "";
    if (!testPhone) return res.status(400).json({ error: "Set PREVIEW_TEST_PHONE env var (e.g. 919869446277) to enable preview sends" });
    const TEST_JID = `${testPhone}@s.whatsapp.net`;

    let plan = loadTodayPlan();
    if (!plan?.length) {
      // Auto-generate if missing
      plan = await runResellerPlanner().catch(() => null);
    }
    if (!plan?.length) {
      return res.status(404).json({ error: "No plan available — try /reseller/plan first" });
    }

    const phone    = req.query.phone;
    const reseller = phone
      ? plan.find(r => r.phone.includes(String(phone).replace(/\.0$/, ""))) ?? plan[0]
      : plan[0];

    res.json({
      message:   `Sending ${reseller.reseller_name}'s picks to test number`,
      reseller:  reseller.reseller_name,
      phone:     reseller.phone,
      products:  reseller.products.length,
      test_jid:  TEST_JID,
    });

    previewInFlight = true;
    previewResellerSend(reseller, TEST_JID)
      .catch(e => console.error("[/reseller/preview]", e.message))
      .finally(() => { previewInFlight = false; });
  });

  // Nuclear reset — clears ALL auth (including creds.json) and forces a fresh QR scan.
  // Use only if DMs are still broken after a normal deploy.
  // After hitting this URL, visit /qr within 60 seconds and scan with the bot's phone.
  app.get("/reset", (_req, res) => {
    const AUTH_DIR = process.env.DATA_DIR
      ? `${process.env.DATA_DIR}/auth`
      : (process.env.AUTH_DIR || "auth");
    try {
      const files = fs.readdirSync(AUTH_DIR);
      for (const f of files) fs.unlinkSync(`${AUTH_DIR}/${f}`);
      console.log(`[Reset] Cleared all ${files.length} auth files — QR rescan required`);
    } catch (e) {
      console.warn("[Reset] Failed:", e.message);
    }
    // Force reconnect — will generate a new QR
    client.isReady = false;
    try { client.sock?.ws?.close(); } catch {}
    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2 style="color:orange">⚠️ Auth cleared</h2>
        <p>Visit <a href="/qr">/qr</a> in 5 seconds and scan with the bot's WhatsApp phone.</p>
        <script>setTimeout(() => location.href='/qr', 5000)</script>
      </body></html>
    `);
  });

  // Root redirects to /qr
  app.get("/", (_req, res) => res.redirect("/qr"));

  app.listen(PORT, () => {
    console.log(`QR server → http://localhost:${PORT}/qr`);
  });
}
