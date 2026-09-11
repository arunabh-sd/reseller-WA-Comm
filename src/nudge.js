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

export const NUDGE_JIDS = new Set(CONTACTS.map(c => toJid(c.phone)));

const CONTACT_BY_JID = new Map(CONTACTS.map(c => [toJid(c.phone), c]));

// ── In-memory conversation state (fresh each day) ─────────────────────────────

const conversations = new Map();

const CONV_TTL_MS = 4 * 60 * 60 * 1000; // expire after 4 hours of no reply

// ── Claude system prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Tum Rounak ho — ShopDeck ke reseller partnership team mein kaam karte ho. Tum personally WhatsApp kar rahe ho apne reseller partners ko, unke saath touch mein rehne ke liye.

Hinglish mein baat karo — jaise actually koi real person karta hai WhatsApp pe. "Aap" use karo respect ke liye. Warm, casual, genuine. Bilkul corporate ya bot jaisa nahi. Short messages — 1-3 sentences max. Emojis theek hain agar natural lage.

Tumhara goal: unse puchho kya chal raha hai, koi issue hai kya, aur agar koi specific collection ya cheez pasand ho toh woh dikhao. Jab tum products share karna chaho, apne message mein exactly yeh tag daalo: [PRODUCTS:category]

Category inme se ek hogi: kurti | saree | western | jewellery | bags

Ek message mein ek hi baar tag use karo, aur tab hi jab genuinely ready ho dikhane ke liye.

Agar koi aisa maange jo available nahi (mens wear, footwear, kids, etc.) — politely batao nahi hai abhi.

Conversation naturally khatam hone do — agar woh bye/thanks keh dein toh warmly respond karo, dobara push mat karo.`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) {
  return n ? `₹${Number(n).toLocaleString("en-IN")}` : "";
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Product fetching ──────────────────────────────────────────────────────────

async function fetchNudgePool(category, shownIds) {
  const weights    = loadWeights();
  const productMap = await getProductMap();
  const validTypes = new Set(CATEGORY_TYPES[category] || []);

  if (!validTypes.size) return [];

  const candidates = [...productMap.values()].filter(p =>
    validTypes.has(p.clean_product_type) &&
    !shownIds.has(p.customer_product_short_id) &&
    (p.reseller_selling_price || 0) > 0
  );

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

async function fetchImage(url) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok || !res.headers.get("content-type")?.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length >= 1024 ? buf : null;
  } catch {
    clearTimeout(timer);
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
        await client.sock.sendMessage(jid, { image: bufs[i], mimetype: "image/jpeg" });
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
    if (sellerPrice) lines.push(`Tumhara price: *${fmt(sellerPrice)}*${websitePrice > sellerPrice ? ` (website pe ${fmt(websitePrice)})` : ""}`);

    if (p.exclusive) {
      lines.push(`🔒 Exclusive — marketplaces pe nahi milega`);
    } else if (p.mp_price && p.mp_price - sellerPrice >= 100) {
      lines.push(`💰 ${fmt(p.mp_price - sellerPrice)} sasta than marketplace`);
    }

    lines.push(`🔗 ${p.qrate_url}`);
    lines.push("");
  });

  lines.push("COD + free delivery ✅ Batao kaisa laga!");

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
    const jid = toJid(contact.phone);

    const opening =
      `Hi ${contact.name} ${contact.honorific}! 👋 Rounak this side, ShopDeck se. ` +
      `Kaise ho aap? Aaj kuch naya collection dekhna hai? ` +
      `Ya koi cheez thi jo pehle pasand nahi aayi? Batao, dekh lete hain 😊`;

    conversations.set(jid, {
      contact,
      history:   [{ role: "assistant", content: opening }],
      shownIds:  new Set(),
      active:    true,
      lastAt:    Date.now(),
    });

    try {
      await client.sendTextMessage(jid, opening);
      console.log(`[Nudge] Opened → ${contact.name} (${jid})`);
    } catch (err) {
      console.error(`[Nudge] Failed to open with ${contact.name}:`, err.message);
      conversations.delete(jid);
    }

    await sleep(2000 + Math.random() * 1000);
  }
}

// Returns true if jid has an active nudge conversation
export function isNudgeJid(jid) {
  const conv = conversations.get(jid);
  if (!conv?.active) return false;
  // Auto-expire
  if (Date.now() - conv.lastAt > CONV_TTL_MS) {
    conv.active = false;
    return false;
  }
  return true;
}

export async function handleNudgeReply(jid, text) {
  const conv = conversations.get(jid);
  if (!conv?.active) return;

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

  // Parse product tag
  const match     = aiText.match(/\[PRODUCTS:(\w+)\]/i);
  const cleanText = aiText.replace(/\[PRODUCTS:\w+\]/gi, "").trim();

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
    const category = match[1].toLowerCase();
    await sleep(800);
    try {
      const pool = await fetchNudgePool(category, conv.shownIds);
      if (pool.length) {
        const sent = await sendNudgeProducts(jid, pool);
        sent.forEach(p => conv.shownIds.add(p.customer_product_short_id));
        console.log(`[Nudge] Sent ${sent.length} ${category} products to ${conv.contact.name}`);
      } else {
        await client.sendTextMessage(
          jid,
          `Hmm, is waqt ${category} mein kuch naya nahi dikh raha. Koi aur category try karein? 😊`
        );
      }
    } catch (err) {
      console.error("[Nudge] Product send failed:", err.message);
    }
  }
}
