import express from "express";
import QRCode from "qrcode";
import client from "./client/whatsapp.js";
import { sendSlot } from "./sender.js";
import { DAILY_SLOTS } from "./config/schedule.js";

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

  // Root redirects to /qr
  app.get("/", (_req, res) => res.redirect("/qr"));

  app.listen(PORT, () => {
    console.log(`QR server → http://localhost:${PORT}/qr`);
  });
}
