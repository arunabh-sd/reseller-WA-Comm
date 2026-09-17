/**
 * Unified reseller chatbot.
 *
 * All inbound DMs route here. Nudge and welcome sends seed the conversation
 * history via seedConvo() so replies have context. Escalation: if Claude
 * doesn't know → hold message to reseller + alert TEST_GROUP → admin replies
 * on TEST_GROUP → relay to reseller + save to learned KB.
 */
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import client from "./client/whatsapp.js";
import { TEST_GROUP_JID } from "./pending_changes.js";
import { fetchNudgePool, sendNudgeProducts } from "./nudge.js";

// ── Learned KB ────────────────────────────────────────────────────────────────

const KB_PATH = process.env.DATA_DIR
  ? `${process.env.DATA_DIR}/kb.json`
  : "/app/data/kb.json";

let _learned = [];

function loadKB() {
  try { _learned = JSON.parse(fs.readFileSync(KB_PATH, "utf8")); }
  catch { _learned = []; }
}

function appendKB(question, answer) {
  _learned.push({ q: question, a: answer, at: new Date().toISOString() });
  if (_learned.length > 300) _learned = _learned.slice(-200);
  try { fs.writeFileSync(KB_PATH, JSON.stringify(_learned, null, 2)); }
  catch (e) { console.warn("[Bot] KB save failed:", e.message); }
}

loadKB();
console.log(`[Bot] Loaded ${_learned.length} learned KB entries`);
// Verify API key is present at startup — fail fast rather than silently
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("[Bot] FATAL: ANTHROPIC_API_KEY is not set — replies will not work");
} else {
  console.log("[Bot] ANTHROPIC_API_KEY present, BASE_URL:", process.env.ANTHROPIC_BASE_URL || "(none — using api.anthropic.com)");
}

// ── Conversations ─────────────────────────────────────────────────────────────

// jid → { history: [{role, content}], shownIds: Set<id>, lastAt: timestamp }
const convos = new Map();

// Seed history after we send a nudge/welcome — so follow-up replies have context.
export function seedConvo(jid, assistantText) {
  const conv = convos.get(jid);
  if (conv) {
    conv.history.push({ role: "assistant", content: assistantText });
    conv.lastAt = Date.now();
  } else {
    convos.set(jid, {
      history:  [{ role: "assistant", content: assistantText }],
      shownIds: new Set(),
      lastAt:   Date.now(),
    });
  }
}

// ── Escalation ────────────────────────────────────────────────────────────────

const pendingEscalations = []; // { jid, question, sentAt }

export function hasPendingEscalation() {
  return pendingEscalations.length > 0;
}

export async function handleEscalationReply(adminText) {
  const esc = pendingEscalations.shift();
  if (!esc) return;

  // Relay admin answer to reseller
  try {
    await client.sendTextMessage(esc.jid, adminText);
    const conv = convos.get(esc.jid);
    if (conv) conv.history.push({ role: "assistant", content: adminText });
    console.log(`[Bot] Relayed escalation answer to ${esc.jid}`);
  } catch (e) {
    console.error("[Bot] Relay failed:", e.message);
  }

  // Save to KB so future queries don't escalate
  appendKB(esc.question, adminText);
  console.log(`[Bot] KB updated — ${_learned.length} entries`);

  await client.sendTextMessage(TEST_GROUP_JID, "✅ Relayed to reseller + KB updated.").catch(() => {});
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildPrompt() {
  const learnedSection = _learned.length
    ? `\n\nLEARNED FROM ADMIN:\n${_learned.slice(-20).map(e => `Q: ${e.q}\nA: ${e.a}`).join("\n\n")}`
    : "";

  return `Tum Rounak ho — ShopDeck se, resellers ki help karte ho.

BAAT KARNE KA STYLE:
- Dost ki tarah, casual. Hinglish. "Aap" use karo.
- 1-2 lines mein jawab do — koi paragraph nahi, koi formal language nahi.
- Emojis thodi si theek hain, overdose nahi.
- Har baar apna introduction mat do — already pata hai kaun ho.
- Push mat karo. Agar koi product nahi maanga toh share mat karo.
- Agar koi seedha baat karna chahta hai toh naturally respond karo.

KYA KAR SAKTE HO (sirf agar poochha ho toh mention karo):
- Koi specific category ya style ke products share kar sakte hain — bolo toh dikhata hoon
- Platform ke baare mein koi bhi sawaal — joining, orders, payments, returns, sab

PLATFORM KI JANKARI — sirf yahi se jawab do, bahar se kuch invent mat karo:

QRate platform:
- Joining bilkul free, koi sign up nahi chahiye
- qrate.shopdeck.com pe jaao, products browse karo aur customers ke saath share karo
- Login sirf tab chahiye jab customer ke liye order place karna ho
- 4 lakh+ products, manufacturers se directly, quality tested (min 100+ customer feedback per product)

Price setting:
- Sharing ke time ya order placement ke time — dono pe price set kar sakte hain
- Har product pe min price (manufacturer cost) aur max price (brand website price) dikhti hai — beech mein apni price rakho

Returns aur quality:
- No questions asked returns agar quality issue ho
- ShopDeck sab shipping aur return shipping cost khud deta hai

Order flow:
- Reseller qrate.shopdeck.com pe jaake customer ke liye order place karta hai
- Customer ko tracking link milta hai; reseller "My Orders" section se track kar sakta hai

Delivery: 4-7 working days

COD:
- Available hai; approx Rs 50 charge — customer deta hai
- Agar customer COD refuse kare → product wapas, reseller aur customer dono se koi charge nahi

Payments:
- Order deliver hone ke baad seedha bank account mein transfer hoti hai
- Bank details: qrate.shopdeck.com → My Account section

Privacy:
- Customer ko sirf reseller ka naam dikhega — ShopDeck ka nahi. Aapka customer aapka hi hai.${learnedSection}

PRODUCTS SHARE KARNA:
Jab reseller koi category ya price range maange, response mein yeh tag daalo:
[PRODUCTS:category]                 — e.g. [PRODUCTS:kurti]
[PRODUCTS:category:filter]          — e.g. [PRODUCTS:kurti:green 500-1500]
Available categories: kurti | saree | western | jewellery | bags
Ek hi tag per reply. Filter sirf tab add karo jab reseller ne clearly specify kiya ho.
Jo available nahi (mens, kids, footwear) — honestly batao aur alternative suggest karo.

RULES:
1. Jo upar nahi diya woh invent mat karo — URLs, policies, features, prices
2. Sirf qrate.shopdeck.com refer karo, koi doosri website ya contact kabhi nahi
3. CRITICAL: Agar jawab bilkul nahi pata, toh SIRF yeh ek word type karo — response mein aur kuch bhi nahi, koi explanation nahi, koi sentence nahi: ESCALATE
4. Har message ka jawab do`;
}

// ── Anthropic client (lazy init) ──────────────────────────────────────────────

let _ai = null;
function ai() {
  if (!_ai) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) { console.error("[Bot] ANTHROPIC_API_KEY not set"); return null; }
    _ai = new Anthropic({
      apiKey: key,
      ...(process.env.ANTHROPIC_BASE_URL && { baseURL: process.env.ANTHROPIC_BASE_URL }),
      defaultHeaders: { "x-litellm-api-key": key },
    });
  }
  return _ai;
}

async function claudeReply(history) {
  const client_ai = ai();
  if (!client_ai) return null;
  const res = await client_ai.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 250,
    system:     buildPrompt(),
    messages:   history,
  });
  return res.content[0]?.text?.trim() || null;
}

// ── Main DM handler ───────────────────────────────────────────────────────────

export async function handleDM(jid, text) {
  let conv = convos.get(jid);
  if (!conv) {
    conv = { history: [], shownIds: new Set(), lastAt: Date.now() };
    convos.set(jid, conv);
  }

  conv.lastAt = Date.now();
  conv.history.push({ role: "user", content: text });
  if (conv.history.length > 14) conv.history = conv.history.slice(-14);

  console.log(`[Bot] ${jid} → "${text.slice(0, 60)}"`);

  // Test shortcut — bypasses Claude so we can verify receive/send works independently
  if (text.trim().toLowerCase() === "ping") {
    try { await client.sendTextMessage(jid, "pong 🏓"); } catch (e) { console.error("[Bot] Ping send failed:", e.message); }
    return;
  }

  let reply;
  try {
    reply = await claudeReply(conv.history);
  } catch (e) {
    console.error("[Bot] Claude error:", e.message, e.status || "", e.error?.message || "");
    return;
  }
  if (!reply) { console.warn("[Bot] Empty reply for", jid); return; }

  console.log(`[Bot] → "${reply.slice(0, 80)}"`);

  // Escalate if Claude's reply is the word ESCALATE (or close variants like "ESCALATE.")
  // Claude sometimes adds surrounding text despite instructions — catch those too.
  // Safety net: cleanText below also strips "escalate" so it never reaches the customer.
  const isEscalate =
    /^\s*escalate[.!?]?\s*$/i.test(reply) ||   // just the word, maybe punctuation
    reply.trim().toUpperCase() === "ESCALATE";   // exact match (legacy)

  if (isEscalate) {
    console.log(`[Bot] ESCALATE detected from ${jid} — sending hold + alerting TEST_GROUP ${TEST_GROUP_JID}`);

    const hold = "Ek second — main abhi check karke bata deta hoon 🙏";
    try { await client.sendTextMessage(jid, hold); } catch (e) {
      console.warn("[Bot] Hold message failed:", e.message);
    }
    conv.history.push({ role: "assistant", content: hold });

    pendingEscalations.push({ jid, question: text, sentAt: Date.now() });
    const alert = `🆘 *Rounak ko nahi pata* — reseller ka sawaal:\n"${text}"\n_(JID: ${jid})_\n\nKya reply karun?`;

    console.log("[Bot] Sending to TEST_GROUP...");
    try {
      // Timeout guard — group sends can hang indefinitely if the session is stale
      await Promise.race([
        client.sock.sendMessage(TEST_GROUP_JID, { text: alert }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("group send timed out after 10s")), 10000)),
      ]);
      console.log(`[Bot] Escalated ✓ TEST_GROUP: "${text.slice(0, 60)}"`);
    } catch (e) {
      console.error("[Bot] Escalation alert FAILED:", e.message);
    }
    return;
  }

  // Parse product tag and strip it from text; also strip ESCALATE as a safety net
  // so it can never leak to the customer even if detection above missed a variant
  const tagMatch  = reply.match(/\[PRODUCTS:(\w+)(?::([^\]]+))?\]/i);
  const cleanText = reply
    .replace(/\[PRODUCTS:\w+(?::[^\]]+)?\]/gi, "")
    .replace(/\bescalate\b/gi, "")
    .trim();

  conv.history.push({ role: "assistant", content: cleanText || reply });

  if (cleanText) {
    try { await client.sendTextMessage(jid, cleanText); }
    catch (e) { console.error("[Bot] Text send failed:", e.message); }
  }

  if (tagMatch) {
    const category = tagMatch[1].toLowerCase();
    const filter   = tagMatch[2]?.trim() || "";
    await new Promise(r => setTimeout(r, 800));
    try {
      const pool = await fetchNudgePool(category, conv.shownIds, filter);
      if (pool.length) {
        const sent = await sendNudgeProducts(jid, pool);
        sent.forEach(p => conv.shownIds.add(p.customer_product_short_id));
        console.log(`[Bot] Sent ${sent.length} ${category}${filter ? ` [${filter}]` : ""} products to ${jid}`);
      } else {
        const msg = filter
          ? `Is waqt "${filter}" ke matching products nahi hain. Koi aur preference batayein?`
          : `Is waqt ${category} mein kuch available nahi. Koi aur category try karein?`;
        await client.sendTextMessage(jid, msg);
      }
    } catch (e) {
      console.error("[Bot] Product send failed:", e.message);
    }
  }
}
