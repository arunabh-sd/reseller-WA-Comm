import client from "./client/whatsapp.js";
import { getProductMap } from "./cache.js";
import { loadWeights } from "./learning.js";

// ── Contacts ──────────────────────────────────────────────────────────────────

const CONTACTS = [
  { name: "Karan",   honorific: "Sir", phone: "9167856948" },
  { name: "Arunabh", honorific: "Sir", phone: "9869446277" },
  { name: "Piyush",  honorific: "Sir", phone: "9553336937" },
];

function toJid(phone) {
  return `91${phone}@s.whatsapp.net`;
}

// Start with @s.whatsapp.net defaults; resolveContactJids() updates with actual @lid JIDs
export const NUDGE_JIDS     = new Set(CONTACTS.map(c => toJid(c.phone)));
export const CONTACT_BY_JID = new Map(CONTACTS.map(c => [toJid(c.phone), c]));

// Learn a JID → contact mapping and add to the whitelist
function learnJid(jid, contact) {
  if (!jid || NUDGE_JIDS.has(jid)) return;
  NUDGE_JIDS.add(jid);
  CONTACT_BY_JID.set(jid, contact);
  console.log(`[Nudge] Learned JID for ${contact.name}: ${jid}`);
}

// Call after WhatsApp connects — resolves real JIDs (may be @lid in newer WhatsApp)
export async function resolveContactJids(sock) {
  await new Promise(r => setTimeout(r, 8000)); // wait for contacts store to populate

  for (const contact of CONTACTS) {
    const phoneJid = toJid(contact.phone);

    // Contacts store: phone JID entry may carry a .lid field in Baileys 6.7+
    const info = sock.contacts?.[phoneJid];
    console.log(`[Nudge] contacts[${phoneJid}] =`, JSON.stringify(info));
    if (info) {
      const lid = info.lid || info.linkedJid || info.phoneJid;
      if (lid && lid !== phoneJid) learnJid(lid, contact);
    }

    // Scan all @lid keys for back-reference to this phone JID
    for (const [key, val] of Object.entries(sock.contacts || {})) {
      if (!key.endsWith('@lid')) continue;
      const linked = val?.phoneJid || val?.linkedJid || val?.id;
      if (linked === phoneJid || (linked && linked.includes(contact.phone))) {
        learnJid(key, contact);
      }
    }

    // onWhatsApp — newer Baileys may return .lid field in the result
    try {
      const results = await sock.onWhatsApp(`+91${contact.phone}`);
      const res = results?.[0];
      console.log(`[Nudge] onWhatsApp(${contact.phone}) =`, JSON.stringify(res));
      if (res) {
        if (res.jid) learnJid(res.jid, contact);
        if (res.lid) learnJid(res.lid, contact);
      }
    } catch (e) {
      console.warn(`[Nudge] onWhatsApp failed for ${contact.phone}:`, e.message);
    }
  }

  console.log(`[Nudge] NUDGE_JIDS after resolve:`, [...NUDGE_JIDS]);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) {
  return n ? `₹${Number(n).toLocaleString("en-IN")}` : "";
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Product fetching ──────────────────────────────────────────────────────────

// Parse "green 500-1500", "₹500 se ₹1500", "red 800 to 1200", etc.
function parseFilter(filterQuery = "") {
  const cleaned = filterQuery.replace(/[₹,]/g, "").trim();
  // Matches: 500-1500 | 500–1500 | 500 to 1500 | 500 se 1500
  const priceMatch = cleaned.match(/(\d+)\s*(?:[-–—]|to|se)\s*(\d+)/i);
  const minPrice = priceMatch ? parseInt(priceMatch[1]) : 0;
  const maxPrice = priceMatch ? parseInt(priceMatch[2]) : Infinity;
  const keywordStr = cleaned.replace(/(\d+)\s*(?:[-–—]|to|se)\s*\d+/gi, "").trim().toLowerCase();
  const keywords = keywordStr.split(/\s+/).filter(w => w.length >= 3);
  return { keywords, minPrice, maxPrice, hasPrice: !!priceMatch };
}

// Search product_name + product_description for all terms.
// Category word uses substring match (flexible); colour/style keywords use word boundary (strict).
export async function fetchNudgePool(category, shownIds, filterQuery = "") {
  const { keywords, minPrice, maxPrice, hasPrice } = parseFilter(filterQuery);
  const weights    = loadWeights();
  const productMap = await getProductMap();
  const catKw      = category.toLowerCase(); // e.g. "kurti", "saree"

  const candidates = [...productMap.values()].filter(p => {
    if (shownIds.has(p.customer_product_short_id)) return false;
    const price = p.reseller_selling_price || 0;
    if (!price) return false;
    if (hasPrice && (price < minPrice || price > maxPrice)) return false;

    const text = `${p.product_name} ${p.product_description || ""}`.toLowerCase();

    // Category: substring match so "kurtis", "kurti set" etc. all pass
    if (!text.includes(catKw)) return false;

    // Extra keywords (color, style): word-boundary match so "green" ≠ "evergreen"
    if (keywords.length && !keywords.every(kw => new RegExp(`\\b${kw}\\b`, "i").test(text))) return false;

    return true;
  });

  if (!candidates.length) return [];

  const norm = arr => { const mx = Math.max(...arr, 1); return arr.map(v => v / mx); };
  const normOrders = norm(candidates.map(p => p.orders_last_30d));
  const normMargin = norm(candidates.map(p => p.margin || 0));
  const normPPO    = norm(candidates.map(p => p.ppo_last_7d));
  const normShares = norm(candidates.map(p => p.shares_last_7d));

  return candidates.map((p, i) => ({
    ...p,
    _score:
      (weights.l30d_orders || 0.40) * normOrders[i] +
      (weights.margin      || 0.25) * normMargin[i] +
      (weights.l7d_views   || 0.20) * normPPO[i]    +
      (weights.l7d_shares  || 0.15) * normShares[i],
  })).sort((a, b) => b._score - a._score).slice(0, 20); // top 20 pool
}

async function fetchImage(url, attempt = 1) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`[nudge img] HTTP ${res.status}`); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 512) { console.warn(`[nudge img] Empty (${buf.length}B)`); return null; }
    return buf;
  } catch (err) {
    clearTimeout(timer);
    if (attempt === 1) { await sleep(1500); return fetchImage(url, 2); }
    console.warn(`[nudge img] Failed: ${err.message}`);
    return null;
  }
}

// Send 4 products: image burst → conversational text
export async function sendNudgeProducts(jid, pool) {
  // Fetch images in parallel, select best 4 with valid images
  const fetched = await Promise.all(
    pool.map(async p => ({ product: p, buffer: await fetchImage(p.img_link) }))
  );

  const withImage    = fetched.filter(x => x.buffer);
  const withoutImage = fetched.filter(x => !x.buffer);
  const selected = [
    ...withImage.slice(0, 4),
    ...withoutImage.slice(0, Math.max(0, 4 - withImage.length)),
  ].slice(0, 4);

  if (!selected.length) return [];

  const prods = selected.map(x => x.product);
  const bufs  = selected.map(x => x.buffer);

  // Image burst
  for (let i = 0; i < prods.length; i++) {
    if (bufs[i]) {
      try {
        const imgSent = await client.sock.sendMessage(jid, { image: bufs[i], mimetype: "image/jpeg" });
        if (imgSent?.key?.id) client.registerSentMsg(imgSent.key.id, { imageMessage: {} });
      } catch (e) {
        console.warn(`[Nudge] Image ${i} failed: ${e.message}`);
      }
    }
    await sleep(400 + Math.random() * 200);
  }

  await sleep(1200);

  // Conversational product list
  const NUMS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"];
  const lines = [];

  prods.forEach((p, i) => {
    lines.push(`${NUMS[i]} *${p.product_name}*`);

    const sellerPrice = p.reseller_selling_price || 0;
    const websitePrice = p.website_price || 0;
    if (sellerPrice) lines.push(`Aapka price: *${fmt(sellerPrice)}*${websitePrice > sellerPrice ? ` (website pe ${fmt(websitePrice)})` : ""}`);

    if (p.exclusive) {
      lines.push(`🔒 Exclusive — marketplaces pe nahi milega`);
    } else if (p.mp_price && p.mp_price - sellerPrice >= 100) {
      lines.push(`💰 ${fmt(p.mp_price - sellerPrice)} marketplace se sasta`);
    }

    lines.push(`🔗 ${p.qrate_url}`);
    lines.push("");
  });

  lines.push("COD + free delivery ✅ Zaroor batayein kaisa laga!");

  await client.sendTextMessage(jid, lines.join("\n").trim());
  return prods;
}

// ── Public API ────────────────────────────────────────────────────────────────

// onSent(jid, text) — called after each successful opening send so bot.js can
// seed the conversation history for the right JID.
export async function startNudgeCampaign(onSent) {
  console.log("[Nudge] Starting daily campaign…");

  for (const contact of CONTACTS) {
    // Always use @s.whatsapp.net for sends — Signal session is indexed by this JID,
    // so replies (which also arrive as @s.whatsapp.net) match the session correctly.
    // @lid JIDs cause a session-JID mismatch that breaks decryption on incoming DMs.
    const jid = toJid(contact.phone);

    const opening =
      `Hi ${contact.name} ${contact.honorific}! 👋 Rounak this side, ShopDeck se. ` +
      `Aaj kuch achhi collections aai hain — kurti, saree, jewellery mein kafi achha stock hai. ` +
      `Koi specific category ya style dekhna tha?`;

    try {
      if (!client.isReady) throw new Error("WhatsApp not ready");
      // Subscribe to presence first — triggers key bundle sync for fresh Signal session.
      // Reduces "Waiting for this message" on receiver's side after a redeploy.
      try { await client.sock.presenceSubscribe(jid); } catch {}
      await sleep(500);
      const sent = await client.sock.sendMessage(jid, { text: opening });
      if (sent?.key?.id) client.registerSentMsg(sent.key.id, { conversation: opening });
      // Capture actual JID from sent receipt — may be @lid for newer WhatsApp users
      const actualJid = sent?.key?.remoteJid;
      if (actualJid && actualJid !== jid) {
        learnJid(actualJid, contact);
      }
      const effectiveJid = actualJid || jid;
      if (onSent) onSent(effectiveJid, opening);
      console.log(`[Nudge] Opened → ${contact.name} (${effectiveJid})`);
    } catch (err) {
      console.error(`[Nudge] Failed to open with ${contact.name}:`, err.message);
    }

    await sleep(2000 + Math.random() * 1000);
  }
}
