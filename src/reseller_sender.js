import client from "./client/whatsapp.js";
import { runResellerPlanner, loadTodayPlan } from "./reseller_planner.js";
import { recordSharedForReseller } from "./reseller_history.js";
import { getJid, getDefaultJid, storeJid } from "./reseller_jids.js";

// ── Message variants ──────────────────────────────────────────────────────────
// Varied so it doesn't look bot-like when received multiple days in a row

const OPENING_VARIANTS = [
  "Maine aaj kuch products dhundhe jo shayad aapko pasand aayein 🌸",
  "Kuch naya aaya hai jo aapke liye perfect lag raha tha — ek nazar daalein 😊",
  "Aaj inhe dekh ke aapka khayal aaya — hope you like them! 🛍️",
  "Specially aapke liye kuch achha nikala hai aaj 🙏",
  "In products pe ek nazar daalein — kafi achha response aa raha hai inhe 💐",
  "Aaj ke bestsellers mein se kuch jo aapke liye soch ke share kar raha hoon 🌟",
  "Maine kuch products alag rakhe hain aapke liye — dekho pasand aata hai kya 😊",
  "Thoda waqt nikalo — yeh products zaroor dekhna! 🎀",
  "Aapke pattern se laga ki yeh aapko suit karenge — have a look 💝",
  "Aaj kuch aise products mile jo aapko acche lag sakte hain 🛒",
  "Customers mein kafi demand hai inki — aapke liye bhi perfect ho sakte hain 🌺",
  "Kuch handpicked products aapke liye — ek nazar daalein 💫",
  "Yeh dekhein — specially aapke customers ke liye sochi selection hai 🎁",
  "In products ka response bahut achha aa raha hai — share karna zaroori laga 🌸",
  "Aaj kuch achha mila — aapke liye lagaya alag, dekh ke batao kaisa laga 🌼",
];

const CLOSING_VARIANTS = [
  "Agar aapko kuch specific dekhna hai toh zaroor batao — dhundh ke share kar deta hoon 🙏",
  "Koi specific category ya style chahiye toh bata dena — nikal deta hoon aapke liye 😊",
  "Kuch aur specific dekhna ho toh DM kar dena — dhundh ke share karunga 🙏",
  "Agar kuch aur dikhana tha — bas bata do, share kar dunga 🌟",
  "Kuch specific hai mann mein toh bata dena — dekh leta hoon aapke liye 🎯",
];

function pickVariant(variants, resellerId) {
  const day  = new Date().getDate();
  const seed = day + (resellerId?.charCodeAt(0) || 0);
  return variants[seed % variants.length];
}

// ── Image fetching ────────────────────────────────────────────────────────────

async function fetchImage(url, attempt = 1) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 512 ? buf : null;
  } catch {
    clearTimeout(timer);
    if (attempt === 1) {
      await sleep(1500);
      return fetchImage(url, 2);
    }
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Core send ─────────────────────────────────────────────────────────────────
// overrideJid: if set, send to this JID instead of the reseller's own JID (for preview/testing)
async function sendToReseller(reseller, overrideJid = null) {
  const { reseller_id, reseller_name, phone, products } = reseller;
  if (!products?.length) return false;

  const storedJid = getJid(phone);
  const targetJid = overrideJid || storedJid || getDefaultJid(phone);

  const opening = pickVariant(OPENING_VARIANTS, reseller_id);
  const closing = pickVariant(CLOSING_VARIANTS, reseller_id);

  try {
    // Pre-warm Signal session
    try { await client.sock.presenceSubscribe(targetJid); } catch {}
    await sleep(600);

    // Opening message — also reveals the actual JID for future sends
    const sentOpening = await client.sock.sendMessage(targetJid, { text: opening });
    const actualJid   = sentOpening?.key?.remoteJid;
    if (actualJid && !storedJid && !overrideJid) {
      const isNew = storeJid(phone, actualJid, { name: reseller_name, reseller_id });
      if (isNew) console.log(`[ResellerSender] Stored JID for ${reseller_name}: ${actualJid}`);
    }

    await sleep(1200);

    // Fetch images in parallel before sending
    const imgBuffers = await Promise.all(products.map(p => fetchImage(p.img_link)));

    // Image burst — WA auto-albums images sent in quick succession
    let imagesSent = 0;
    for (let i = 0; i < products.length; i++) {
      if (imgBuffers[i]) {
        try {
          await client.sock.sendMessage(targetJid, { image: imgBuffers[i], mimetype: "image/jpeg" });
          imagesSent++;
        } catch (e) {
          console.warn(`[ResellerSender] Image ${i} failed for ${reseller_name}: ${e.message}`);
        }
      }
      await sleep(300 + Math.random() * 200);
    }

    await sleep(1500); // let WA render the album before the links arrive

    // Links message — numbered, one blank line between each
    const links = products
      .map((p, i) => `${i + 1}- ${p.qrate_url}`)
      .filter(l => l.includes("http"))
      .join("\n\n");
    if (links) {
      await client.sock.sendMessage(targetJid, { text: links });
    }

    await sleep(800);

    // Closing message
    await client.sock.sendMessage(targetJid, { text: closing });

    // Record for de-duplication (only if this is a real send, not a preview override)
    if (!overrideJid) {
      recordSharedForReseller(reseller_id, products.map(p => p.product_id));
    }

    console.log(`[ResellerSender] ✓ ${reseller_name} (${phone}) — ${imagesSent} images, ${products.length} links`);
    return true;
  } catch (err) {
    console.error(`[ResellerSender] Failed for ${reseller_name} (${phone}):`, err.message);
    return false;
  }
}

// ── Daily campaign ────────────────────────────────────────────────────────────
// Reads today's plan (generating it if missing) and sends to all resellers
export async function sendDailyResellerCampaign() {
  let plan = loadTodayPlan();
  if (!plan) {
    console.log("[ResellerSender] No plan for today — running planner first…");
    plan = await runResellerPlanner();
  }
  if (!plan?.length) {
    console.log("[ResellerSender] Empty plan — nothing to send");
    return;
  }

  console.log(`[ResellerSender] Campaign start: ${plan.length} resellers`);

  let sent = 0, failed = 0;
  for (const reseller of plan) {
    const ok = await sendToReseller(reseller);
    if (ok) sent++; else failed++;
    // 4–7s gap between resellers to avoid WA flood detection
    await sleep(4000 + Math.random() * 3000);
  }

  console.log(`[ResellerSender] Campaign done — sent: ${sent}, failed: ${failed}`);
}

// ── Preview / test send ───────────────────────────────────────────────────────
// Generates plan for the given reseller entry and sends to testJid (Arunabh's number).
// Products are NOT recorded in reseller history — this is a dry-run preview.
export async function previewResellerSend(reseller, testJid) {
  console.log(`[ResellerSender] Preview: ${reseller.reseller_name} → ${testJid}`);
  return sendToReseller(reseller, testJid);
}
