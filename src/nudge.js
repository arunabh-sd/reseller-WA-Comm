import Anthropic from "@anthropic-ai/sdk";
import client from "./client/whatsapp.js";
import { getProductMap } from "./cache.js";
import { CATEGORY_TYPES } from "./config/categories.js";
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

// Call after WhatsApp connects — resolves real JIDs (may be @lid in newer WhatsApp)
export async function resolveContactJids(sock) {
  await new Promise(r => setTimeout(r, 3000)); // let contacts store populate

  for (const contact of CONTACTS) {
    const phoneJid = toJid(contact.phone);

    // Log whatever Baileys has for this phone JID so we can see the structure
    const info = sock.contacts?.[phoneJid];
    console.log(`[Nudge] contacts[${phoneJid}] =`, JSON.stringify(info));

    // Check if contacts store has an @lid mapped from this phone JID
    if (info) {
      const lid = info.lid || info.linkedJid || info.phoneJid;
      if (lid && lid !== phoneJid) {
        NUDGE_JIDS.add(lid);
        CONTACT_BY_JID.set(lid, contact);
        console.log(`[Nudge] Learned LID for ${contact.name}: ${lid}`);
      }
    }

    // Scan ALL contacts entries in case indexed by @lid with a reference back
    for (const [key, val] of Object.entries(sock.contacts || {})) {
      if (!key.endsWith('@lid')) continue;
      const linked = val.phoneJid || val.linkedJid || val.id;
      if (linked === phoneJid) {
        NUDGE_JIDS.add(key);
        CONTACT_BY_JID.set(key, contact);
        console.log(`[Nudge] Found LID for ${contact.name}: ${key}`);
      }
    }

    // Also try onWhatsApp as a fallback
    try {
      const results = await sock.onWhatsApp(`+91${contact.phone}`);
      if (results?.[0]?.jid && !NUDGE_JIDS.has(results[0].jid)) {
        NUDGE_JIDS.add(results[0].jid);
        CONTACT_BY_JID.set(results[0].jid, contact);
        console.log(`[Nudge] onWhatsApp resolved ${contact.name}: ${results[0].jid}`);
      }
    } catch (e) {
      console.warn(`[Nudge] onWhatsApp failed for ${contact.phone}:`, e.message);
    }
  }

  console.log(`[Nudge] NUDGE_JIDS after resolve:`, [...NUDGE_JIDS]);
}

// ── In-memory conversation state (fresh each day) ─────────────────────────────

const conversations = new Map();

const CONV_TTL_MS = 4 * 60 * 60 * 1000; // expire after 4 hours of no reply

// ── Claude system prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Tum Rounak ho — ShopDeck mein kaam karte ho aur kuch resellers ke saath personally touch mein rehte ho. Tumhara kaam hai unhe naye aur trending products ke baare mein update karna aur jo specific chaahein woh dikhana.

WhatsApp pe Hinglish mein baat karo — natural, warm, friendly. "Aap" use karo. 1-3 short sentences max. Emojis theek hain agar natural lage.

Genuinely helpful bano — unki preference samjho aur us hisaab se products suggest karo. Products ke baare mein enthusiastic raho (bestsellers, margins, exclusives) — jaise ek knowledgeable dost jo sach mein achha stuff jaanta ho. Kabhi bhi creepy ya pushy mat lagna.

Products dikhane ke liye:
[PRODUCTS:category]               — best picks from that category
[PRODUCTS:category:green]         — jab user ne color mention kiya ho
[PRODUCTS:category:500-1500]      — jab user ne price range batai ho (RSP filter hoga)
[PRODUCTS:category:green 500-1500] — dono criteria

Filter SIRF tab add karo jab user ne clearly specify kiya ho.
Available: kurti | saree | western | jewellery | bags
Jo nahi hai (mens, footwear, kids) — honestly batao.

Ek tag per message. Conversation naturally end hone do — pressure nahi dena.`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) {
  return n ? `₹${Number(n).toLocaleString("en-IN")}` : "";
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Product fetching ──────────────────────────────────────────────────────────

// Parse a filter like "green 500-1500" → { keywords: ["green"], minPrice: 500, maxPrice: 1500 }
function parseFilter(filterQuery = "") {
  const priceMatch = filterQuery.match(/(\d+)\s*[-–]\s*(\d+)/);
  const minPrice = priceMatch ? parseInt(priceMatch[1]) : 0;
  const maxPrice = priceMatch ? parseInt(priceMatch[2]) : Infinity;
  const keywordStr = filterQuery.replace(/\d+\s*[-–]\s*\d+/g, "").trim().toLowerCase();
  const keywords = keywordStr.split(/\s+/).filter(w => w.length >= 3);
  return { keywords, minPrice, maxPrice, hasPrice: !!priceMatch };
}

function matchesKeywords(product, keywords) {
  if (!keywords.length) return true;
  const text = `${product.product_name} ${product.product_description || ""}`.toLowerCase();
  return keywords.every(kw => new RegExp(`\\b${kw}\\b`).test(text));
}

async function fetchNudgePool(category, shownIds, filterQuery = "") {
  const { keywords, minPrice, maxPrice, hasPrice } = parseFilter(filterQuery);
  const weights    = loadWeights();
  const productMap = await getProductMap();
  const validTypes = new Set(CATEGORY_TYPES[category] || []);

  if (!validTypes.size) return [];

  const candidates = [...productMap.values()].filter(p => {
    if (!validTypes.has(p.clean_product_type)) return false;
    if (shownIds.has(p.customer_product_short_id)) return false;
    const price = p.reseller_selling_price || 0;
    if (!price) return false;
    if (hasPrice && (price < minPrice || price > maxPrice)) return false;
    if (!matchesKeywords(p, keywords)) return false;
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
async function sendNudgeProducts(jid, pool) {
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

// ── Claude call ───────────────────────────────────────────────────────────────

async function getAIReply(history) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const anthropic = new Anthropic({
    apiKey,
    ...(process.env.ANTHROPIC_BASE_URL && { baseURL: process.env.ANTHROPIC_BASE_URL }),
    defaultHeaders: { "x-litellm-api-key": apiKey },
  });

  const msg = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 200,
    system:     SYSTEM_PROMPT,
    messages:   history,
  });

  return msg.content[0]?.text?.trim() || null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function startNudgeCampaign() {
  console.log("[Nudge] Starting daily campaign…");

  for (const contact of CONTACTS) {
    // Prefer known @lid over @s.whatsapp.net to avoid "waiting for this message" on receiver
    const knownLid = [...CONTACT_BY_JID.entries()].find(
      ([j, c]) => c === contact && j.endsWith("@lid")
    )?.[0];
    const jid = knownLid || toJid(contact.phone);

    const opening =
      `Hi ${contact.name} ${contact.honorific}! 👋 Rounak this side, ShopDeck se. ` +
      `Aaj kuch achhi collections aai hain — kurti, saree, jewellery mein kafi achha stock hai. ` +
      `Koi specific category ya style dekhna tha?`;

    conversations.set(jid, {
      contact,
      history:   [{ role: "assistant", content: opening }],
      shownIds:  new Set(),
      active:    true,
      lastAt:    Date.now(),
    });

    try {
      if (!client.isReady) throw new Error("WhatsApp not ready");
      const sent = await client.sock.sendMessage(jid, { text: opening });
      if (sent?.key?.id) client.registerSentMsg(sent.key.id, { conversation: opening });
      // Capture the actual JID WhatsApp used (may be @lid instead of @s.whatsapp.net)
      const actualJid = sent?.key?.remoteJid;
      if (actualJid && actualJid !== jid) {
        NUDGE_JIDS.add(actualJid);
        CONTACT_BY_JID.set(actualJid, contact);
        conversations.set(actualJid, conversations.get(jid));
        console.log(`[Nudge] Learned JID for ${contact.name}: ${actualJid}`);
      }
      console.log(`[Nudge] Opened → ${contact.name}`);
    } catch (err) {
      console.error(`[Nudge] Failed to open with ${contact.name}:`, err.message);
      conversations.delete(jid);
    }

    await sleep(2000 + Math.random() * 1000);
  }
}

// Dynamically resolve an @lid JID to one of our contacts
async function resolveContactFromLid(lid) {
  if (CONTACT_BY_JID.has(lid)) return CONTACT_BY_JID.get(lid);

  const allContacts = client.sock?.contacts || {};
  const lidEntry = allContacts[lid];
  console.log(`[Nudge] contacts[${lid}] =`, JSON.stringify(lidEntry));

  // Strategy 1: @lid entry has a linked phone JID
  if (lidEntry) {
    const phoneRef = lidEntry.lid || lidEntry.phoneJid || lidEntry.linkedJid || lidEntry.jid || lidEntry.id;
    if (phoneRef && phoneRef !== lid) {
      for (const contact of CONTACTS) {
        if (phoneRef.includes(contact.phone)) {
          NUDGE_JIDS.add(lid);
          CONTACT_BY_JID.set(lid, contact);
          console.log(`[Nudge] Resolved ${contact.name} via lidEntry.phoneRef: ${phoneRef}`);
          return contact;
        }
      }
    }
  }

  // Strategy 2: scan @s.whatsapp.net entries for a back-reference to this @lid
  for (const [key, val] of Object.entries(allContacts)) {
    if (!key.endsWith('@s.whatsapp.net') && !key.endsWith('@lid')) continue;
    const linkedLid = val?.lid || val?.linkedJid;
    if (linkedLid === lid) {
      for (const contact of CONTACTS) {
        if (key.includes(contact.phone)) {
          NUDGE_JIDS.add(lid);
          CONTACT_BY_JID.set(lid, contact);
          console.log(`[Nudge] Resolved ${contact.name} via back-ref from ${key}`);
          return contact;
        }
      }
    }
  }

  // Strategy 3: onWhatsApp lookup (returns @s.whatsapp.net, probably won't match @lid)
  for (const contact of CONTACTS) {
    try {
      const results = await client.sock.onWhatsApp(`+91${contact.phone}`);
      if (results?.[0]?.jid === lid) {
        NUDGE_JIDS.add(lid);
        CONTACT_BY_JID.set(lid, contact);
        console.log(`[Nudge] Resolved ${contact.name} via onWhatsApp: ${lid}`);
        return contact;
      }
    } catch {}
  }

  // Strategy 4: dump a few contacts entries so we can see the actual data structure
  const sample = Object.entries(allContacts).slice(0, 5).map(([k,v]) => `${k}=${JSON.stringify(v)}`);
  console.log(`[Nudge] contacts sample:`, sample.join(' | '));

  return null;
}

// Route ALL @lid individual chats to nudge — group chats end in @g.us
export function isNudgeJid(jid) {
  if (NUDGE_JIDS.has(jid)) return true;
  if (jid?.endsWith('@lid')) return true; // resolve happens inside handleNudgeReply
  return false;
}

export async function handleNudgeReply(jid, text) {
  let conv = conversations.get(jid);

  if (!conv || !conv.active) {
    let contact = CONTACT_BY_JID.get(jid);

    // For unknown @lid JIDs, try to resolve to a known contact
    if (!contact && jid?.endsWith('@lid')) {
      contact = await resolveContactFromLid(jid);
    }

    // Safety fallback: if still unresolved but @lid, allow up to 3 active unknown convos
    // (almost certainly one of our 3 contacts replying to the campaign)
    if (!contact && jid?.endsWith('@lid')) {
      const unknownLids = [...conversations.keys()].filter(k => k.endsWith('@lid') && !CONTACT_BY_JID.has(k));
      if (unknownLids.length < 3) {
        contact = { name: "Sir", honorific: "", phone: "unknown" };
        console.log(`[Nudge] Using fallback contact for unresolved @lid: ${jid}`);
      }
    }

    if (!contact) return; // not an @lid or too many unknown convos
    conv = { contact, history: [], shownIds: new Set(), active: true, lastAt: Date.now() };
    conversations.set(jid, conv);
  }

  conv.lastAt = Date.now();
  conv.history.push({ role: "user", content: text });

  let aiText;
  try {
    aiText = await getAIReply(conv.history);
  } catch (err) {
    console.error("[Nudge] Claude error:", err.message);
    return;
  }
  if (!aiText) return;

  // Parse product tag — [PRODUCTS:category] or [PRODUCTS:category:filter]
  const match     = aiText.match(/\[PRODUCTS:(\w+)(?::([^\]]+))?\]/i);
  const cleanText = aiText.replace(/\[PRODUCTS:\w+(?::[^\]]+)?\]/gi, "").trim();

  conv.history.push({ role: "assistant", content: cleanText || aiText });

  // Send text reply
  if (cleanText) {
    try {
      await client.sendTextMessage(jid, cleanText);
    } catch (err) {
      console.error("[Nudge] Text send failed:", err.message);
    }
  }

  // Send products if Claude requested them
  if (match) {
    const category    = match[1].toLowerCase();
    const filterQuery = match[2]?.trim() || "";
    await sleep(800);
    try {
      const pool = await fetchNudgePool(category, conv.shownIds, filterQuery);
      if (pool.length) {
        const sent = await sendNudgeProducts(jid, pool);
        sent.forEach(p => conv.shownIds.add(p.customer_product_short_id));
        console.log(`[Nudge] Sent ${sent.length} ${category}${filterQuery ? ` [${filterQuery}]` : ""} products to ${conv.contact.name}`);
      } else {
        const noMatchMsg = filterQuery
          ? `Is waqt "${filterQuery}" ke matching koi product available nahi hai. Kya aap koi aur preference batayenge?`
          : `Is waqt ${category} mein kuch available nahi hai. Koi aur category try karein?`;
        await client.sendTextMessage(jid, noMatchMsg);
      }
    } catch (err) {
      console.error("[Nudge] Product send failed:", err.message);
    }
  }
}
