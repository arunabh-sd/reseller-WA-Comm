import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import client from "./client/whatsapp.js";
import { TEST_GROUP_JID } from "./pending_changes.js";
import { fetchNudgePool, sendNudgeProducts } from "./nudge.js";

// ── Config ────────────────────────────────────────────────────────────────────

export const COMMUNITY_JIDS = [
  "120363410134784350@g.us",
  "120363428254767701@g.us",
];

const COMMUNITY_NAMES = {
  "120363410134784350@g.us": "QRate Community 1",
  "120363428254767701@g.us": "QRate Community 2",
};

const DATA_PATH = process.env.DATA_DIR
  ? `${process.env.DATA_DIR}/community_members.json`
  : "/app/data/community_members.json";

// ── Persistence ───────────────────────────────────────────────────────────────

function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function emptyDay(date) {
  const d = { date };
  for (const jid of COMMUNITY_JIDS) d[jid] = { joined: [], left: [] };
  return d;
}

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch {
    return { today: null, yesterday: null, pendingWelcome: [] };
  }
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn("[Community] Save failed:", e.message);
  }
}

// Rolls over to a new IST day automatically.
function getStore() {
  const data = loadData();
  const today = todayIST();
  if (!data.today || data.today.date !== today) {
    data.yesterday = data.today || emptyDay(today);
    data.today = emptyDay(today);
    if (!data.pendingWelcome) data.pendingWelcome = [];
    saveData(data);
  }
  return data;
}

// ── Member tracking ───────────────────────────────────────────────────────────

export function trackParticipantUpdate(groupJid, action, memberJids) {
  if (!COMMUNITY_JIDS.includes(groupJid)) return;

  const data = getStore();

  for (const jid of memberJids) {
    if (action === "add") {
      if (!data.today[groupJid].joined.includes(jid)) {
        data.today[groupJid].joined.push(jid);
      }
      const alreadyQueued = data.pendingWelcome.some(e => e.memberJid === jid);
      if (!alreadyQueued && !activeWelcomeConvos.has(jid)) {
        data.pendingWelcome.push({ memberJid: jid, groupJid, joinedAt: Date.now() });
      }
    } else if (action === "remove") {
      if (!data.today[groupJid].left.includes(jid)) {
        data.today[groupJid].left.push(jid);
      }
    }
  }

  saveData(data);
  const name = COMMUNITY_NAMES[groupJid] || groupJid;
  console.log(`[Community] ${action} ${memberJids.length} in ${name}`);
}

// ── Member count reports ──────────────────────────────────────────────────────

function formatReport(title, dayData) {
  if (!dayData) return `📊 *${title}*\nData available nahi hai.`;

  const lines = [`📊 *${title}*`, ""];
  for (const jid of COMMUNITY_JIDS) {
    const name  = COMMUNITY_NAMES[jid] || jid;
    const stats = dayData[jid] || { joined: [], left: [] };
    const joined = stats.joined.length;
    const left   = stats.left.length;
    const net    = joined - left;
    lines.push(`*${name}*`);
    lines.push(`✅ Joined: ${joined}  ❌ Left: ${left}  Net: ${net >= 0 ? "+" : ""}${net}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export async function sendYesterdayReport() {
  getStore(); // ensure rollover before reading yesterday
  const data = loadData();
  const msg = formatReport("Yesterday's Final Count", data.yesterday);
  try {
    await client.sendTextMessage(TEST_GROUP_JID, msg);
    console.log("[Community] Sent yesterday report");
  } catch (e) {
    console.error("[Community] Yesterday report failed:", e.message);
  }
}

export async function sendTodayReport() {
  const data = getStore();
  const now = new Date().toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true,
  });
  const msg = formatReport(`Today's Count (as of ${now} IST)`, data.today);
  try {
    await client.sendTextMessage(TEST_GROUP_JID, msg);
    console.log("[Community] Sent today report");
  } catch (e) {
    console.error("[Community] Today report failed:", e.message);
  }
}

// ── Welcome message ───────────────────────────────────────────────────────────

function buildWelcomeMessage(communityJid) {
  const name = COMMUNITY_NAMES[communityJid] || "ShopDeck Resellers";
  return [
    `👋 Namaste! *${name}* community mein aapka swagat hai!`,
    ``,
    `Main Rounak hoon — aapka ShopDeck point of contact. 😊`,
    ``,
    `🛍️ *QRate kya hai?*`,
    `QRate by ShopDeck ek reseller platform hai jahan aap:`,
    `• Manufacturers se directly listed *4 lakh+ tested products* explore karein`,
    `• Apna price khud set karein (min aur max ke beech)`,
    `• WhatsApp ya kisi bhi platform pe customers ke saath share karein`,
    `• Shipping, COD, returns — *sab humara zimma* ✅`,
    `• Margin deliver hone ke baad seedha bank mein`,
    ``,
    `*Aapka customer aapka hi rehta hai* — unhe sirf aapka naam dikhega, ShopDeck ka nahi. 🔒`,
    ``,
    `Humne sirf wahi products list kiye hain jinke paas 100+ customers ka accha quality feedback hai — quality guaranteed!`,
    ``,
    `📦 *Browse karein category wise:*`,
    `👗 Kurtis — https://tinyurl.com/Qrate-Kurtis`,
    `🥻 Sarees — https://tinyurl.com/Qrate-Sarees`,
    `💍 Jewellery — https://tinyurl.com/Qrate-Jewellery`,
    `👜 Bags — https://tinyurl.com/Qrate-Bags`,
    `🔍 Sab categories — https://qrate.shopdeck.com/browse`,
    ``,
    `✨ *Aap kya bechte hain aur kaunse price range mein?* Mujhe batayein — main personally aapke liye best products select karke share karta hoon!`,
    ``,
    `Koi bhi sawaal ho toh yahan poochh sakte hain 😊`,
  ].join("\n");
}

// ── Chatbot ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Tum Rounak ho — ShopDeck ke reseller support executive. Naye community members ke sawaalon ka jawab do aur products share karo jab maangi jaayein.

KNOWLEDGE BASE — sirf yahi se jawab do, kuch bhi bahar se invent mat karo:

Platform basics:
- Joining bilkul free, koi sign up nahi chahiye
- qrate.shopdeck.com pe jaao, products browse karo aur share karo
- Login sirf tab chahiye jab customer ke liye order place karna ho

Price setting:
- Sharing ke time ya order placement ke time dono pe price set kar sakte hain
- Har product pe min price (manufacturer cost) aur max price (brand website price) dikhti hai — aap beech mein jo chahein rakho

Product quality:
- Sirf wahi products listed hain jahan 100+ customers ka quality feedback ho aur wo accha ho — quality guaranteed
- Phir bhi issue ho toh no questions asked returns, ShopDeck sab shipping aur return shipping cost deta hai

Order flow:
- Customer order karna chahe → reseller qrate.shopdeck.com pe jaake customer ke liye order place karta hai
- Customer ko order tracking link milta hai, reseller "My Orders" section se track kar sakta hai

Delivery: 4–7 working days

COD:
- Available hai
- COD charge approx ₹50 — customer deta hai
- Agar customer COD refuse kare → product wapas seller ke paas, reseller aur customer dono se koi charge nahi

Payments:
- Order deliver hone ke baad payment milti hai
- Seedha bank account mein transfer hoti hai
- Bank details daalni hain: qrate.shopdeck.com → My Account section

Privacy:
- Customer ko sirf reseller ka naam dikhega — ShopDeck ka nahi. Aapka customer aapka hi hai.

Agar koi aur cheez pooche jo upar cover nahi:
- Yahi kaho: "Iske baare mein aap qrate.shopdeck.com pe ja ke dekh sakte hain — wahan sab details available hain"
- Koi doosri website, phone number, email ya document KABHI refer mat karo siwaaye qrate.shopdeck.com ke

PRODUCTS SHARE KARNE KE LIYE:
Jab reseller koi category ya price range maange toh response mein yeh tag daalo:
[PRODUCTS:category]                — e.g. [PRODUCTS:kurti]
[PRODUCTS:category:filter]         — e.g. [PRODUCTS:kurti:green 500-1500]
Available categories: kurti | saree | western | jewellery | bags
Ek hi tag per reply. Filter tab add karo jab reseller ne clearly color ya price range bola ho.
Jo available nahi (mens, kids, footwear) — honestly batao.

RULES:
- Hinglish, warm aur helpful, 1-3 sentences max
- Koi bhi cheez invent mat karo jo upar nahi di — URLs, features, pricing, policies
- Pehle message ke baad sirf tab respond karo jab reseller ne kuch poocha ya maanga ho`;

// In-memory active conversations: memberJid → { history, lastAt, communityJid, shownIds }
const activeWelcomeConvos = new Map();

export function isWelcomeJid(jid) {
  return activeWelcomeConvos.has(jid);
}

function isBusinessHours() {
  const hour = parseInt(
    new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false })
  );
  return hour >= 9 && hour < 20;
}

export async function processWelcomeQueue() {
  if (!isBusinessHours()) return;

  const data = loadData();
  if (!data.pendingWelcome?.length) return;

  // Drop entries older than 48h (stale — they missed two 9am windows)
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const toProcess = data.pendingWelcome.filter(e => e.joinedAt > cutoff);

  data.pendingWelcome = [];
  saveData(data);

  if (!toProcess.length) return;
  console.log(`[Community] Sending ${toProcess.length} welcome message(s)`);

  for (const entry of toProcess) {
    if (activeWelcomeConvos.has(entry.memberJid)) continue;

    const welcomeMsg = buildWelcomeMessage(entry.groupJid);

    try {
      await client.sendTextMessage(entry.memberJid, welcomeMsg);
      activeWelcomeConvos.set(entry.memberJid, {
        history:      [{ role: "assistant", content: welcomeMsg }],
        lastAt:       Date.now(),
        communityJid: entry.groupJid,
        shownIds:     new Set(),
      });
      console.log(`[Community] Welcomed ${entry.memberJid}`);
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
    } catch (e) {
      console.warn(`[Community] Welcome failed for ${entry.memberJid}:`, e.message);
    }
  }
}

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

export async function handleWelcomeReply(jid, text) {
  let conv = activeWelcomeConvos.get(jid);
  if (!conv) {
    conv = { history: [], lastAt: Date.now(), shownIds: new Set() };
    activeWelcomeConvos.set(jid, conv);
  }

  conv.lastAt = Date.now();
  conv.history.push({ role: "user", content: text });
  if (conv.history.length > 10) conv.history = conv.history.slice(-10);

  let aiText;
  try {
    aiText = await getAIReply(conv.history);
  } catch (e) {
    console.error("[Community] Claude error:", e.message);
    return;
  }
  if (!aiText) return;

  // Parse optional product tag
  const match     = aiText.match(/\[PRODUCTS:(\w+)(?::([^\]]+))?\]/i);
  const cleanText = aiText.replace(/\[PRODUCTS:\w+(?::[^\]]+)?\]/gi, "").trim();

  conv.history.push({ role: "assistant", content: cleanText || aiText });

  if (cleanText) {
    try {
      await client.sendTextMessage(jid, cleanText);
    } catch (e) {
      console.error("[Community] Text send failed:", e.message);
    }
  }

  if (match) {
    const category    = match[1].toLowerCase();
    const filterQuery = match[2]?.trim() || "";
    await new Promise(r => setTimeout(r, 800));
    try {
      const pool = await fetchNudgePool(category, conv.shownIds, filterQuery);
      if (pool.length) {
        const sent = await sendNudgeProducts(jid, pool);
        sent.forEach(p => conv.shownIds.add(p.customer_product_short_id));
        console.log(`[Community] Sent ${sent.length} ${category} products to ${jid}`);
      } else {
        const noMatch = filterQuery
          ? `Is waqt "${filterQuery}" ke matching products nahi hain. Koi aur preference batayein?`
          : `Is waqt ${category} mein kuch available nahi. Koi aur category try karein?`;
        await client.sendTextMessage(jid, noMatch);
      }
    } catch (e) {
      console.error("[Community] Product send failed:", e.message);
    }
  }
}
