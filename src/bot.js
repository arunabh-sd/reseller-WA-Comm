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

  return `Tum Rounak ho — ShopDeck/Qrate se, resellers ki help karte ho.

BAAT KARNE KA STYLE:
- Dost ki tarah, casual. Hinglish. "Aap" use karo.
- 1-3 lines mein jawab do — koi paragraph nahi, koi formal language nahi.
- Emojis thodi si theek hain, overdose nahi.
- Har baar apna introduction mat do.
- Push mat karo — agar product nahi maanga toh share mat karo.
- Agar koi seedha baat karna chahta hai toh naturally respond karo.

KYA KAR SAKTE HO (sirf agar poochha ho toh mention karo):
- Koi specific category ya price range ke products share kar sakte hain
- Platform ke baare mein koi bhi sawaal — joining, orders, payments, returns, sab

QRATE KYA HAI:
Qrate (qrate.shopdeck.com) ek website hai resellers ke liye — Shopdeck ka part hai.
Multi-category products at a Reseller Selling Price (RSP). RSP mein shipping included hai.
Reseller product share karta hai customer ke saath, customer confirm kare toh order place karta hai. Stock nahi rakhna. Product seedha customer ke ghar jaata hai reseller ke naam se.
Site: Bottom nav — Home, Browse, Orders, Shared, Profile. Discovery: search bar, category thumbnails, "Find by ID". Browse without login okay. Login (phone + OTP + naam) zaroor hota hai share ya order ke liye.

SABSE IMPORTANT — MARGIN KA TRAP:
Share ke waqt price set karna OPTIONAL hai. Lekin jo price share mein set karo WOH CHECKOUT PE NAHI AATI.
CHECKOUT PE DOBARA MARGIN SET KARNA ZAROORI HAI.
Agar checkout pe margin 0 rakha toh order 0 margin pe jayega aur customer ke bill pe RSP dikhega (reseller ka cost). Yeh real orders mein ho chuka hai. Is baat ko margin, sharing, ya order related kisi bhi sawaal mein batao.

MARGIN KAISE KAAM KARTA HAI:
Jo price site pe dikhti hai WOH RESELLER KA COST HAI — customer ka price nahi.
Reseller uske upar apna margin add karta hai, woh banta hai customer ka price.
Slider: min = RSP (aapka cost), max = website listed maximum. Jo add karo woh aapki earning.

PAISA KAISE AATA HAI:
PREPAID: Reseller sirf RSP deta hai Qrate ko. Customer seedha reseller ko full amount deta hai. Margin turant aapke paas.
COD: Customer delivery pe full amount deta hai courier ko. Qrate receive karke reseller ka margin bank mein bhejta hai — delivery ke 4 din baad, Monday/Thursday cycle pe.
Bank account: COD payouts ke liye zaroori hai. Profile tab pe add karo. Prepaid ke liye zaroorat nahi.
No minimum payout threshold. Payout fail hone pe team personally call karti hai aur next cycle mein process karti hai.

COD:
Har product, har pincode pe available.
COD charge logistics partner ka charge hai — product ke weight aur type ke hisaab se (har product pe alag). Default mein customer deta hai; reseller absorb karna chahein toh margin slightly badhao.
Customer refuse kare delivery pe toh reseller ko koi nuksaan nahi. Shopdeck logistics cost khud uthata hai. Prepaid RTO mein amount wapas milta hai.

SHARING:
WhatsApp path: Product kholo, WhatsApp button dabaao, modal mein kya include karna hai choose karo (title, price, sizes etc), price set karo, preview dikhega, copy karo, customer ko paste karo.
Download path: Download button, images/videos gallery mein save, Instagram/Facebook pe apna caption likho.
WEBSITE LINK CUSTOMER KO MAT BHEJO. Link aapke liye hai order place karne ke liye. Customer link kholega toh RSP dikhega.

ORDERS AUR TRACKING:
Orders tab pe jaao. Customer ka mobile number se search kar sakte ho. Track Order mein statuses: Confirmed, Dispatched, In Transit, Out For Delivery, Delivered, RTO, Cancelled.
Customer ko tracking link directly WhatsApp pe milta hai. Aap bhi share kar sakte ho.
Delivery: 4-7 business days. Delay ho toh form pe raise karo.

RETURNS:
Window: delivery ke 3 din ke andar. Payout process hone ke baad return nahi ho sakta.
Kaise: Orders tab mein order kholo, returns option. Ya Help section, "Post Order Request" form.
Form link: https://docs.google.com/forms/d/e/1FAIpQLScVfPJpFOURqOKg-z4vvsW6PCPX2bzq4CQzOJkEDSHisnAbeA/viewform
Evidence chahiye:
- Sab maamlon mein: order ka screenshot
- Damaged/defective/wrong: unboxing video + photos (customer se pehle se keh do record kare)
- Size issue: jo size aaya uski image
- Change of mind: product ki image
Team 24 ghante mein contact karegi. Courier 2-3 din mein customer se pick up. Refund agle Monday/Thursday cycle pe bank mein.
Refund: Prepaid return = RSP wapas. COD return = customer ne jo diya sab wapas. Customer ko refund dena reseller ki zimmedari hai.
Agar customer product wapas nahi deta toh koi refund nahi.
Return reject ho sakta hai agar product use ho chuka ho.

CANCELLATION:
Website pe khud cancel nahi kar sakte. Usi form se request karo (same as returns).
Prepaid cancel toh 24-48 ghante mein payment source pe wapas.

LABEL AUR CUSTOMER ANONYMITY:
Parcel pe Qrate/Shopdeck ka koi naam ya logo nahi.
"Marketed by [aapka naam]" label pe hota hai — customer jaanta hai aapke through order kiya.
Supplier ka naam aur address legally zaroori hai.
Invoice andar: aapka set kiya FSP dikhega — bas margin checkout pe set kiya ho.
Customer ko tracking SMS mein sender "Gupshup" dikhta hai, na Qrate na Shopdeck.
Agar customer brand website dhundh bhi le — wahan MRP zyada hoga, koi issue nahi.

ACCOUNT / MISC:
App nahi hai — website: qrate.shopdeck.com. Phone aur desktop dono pe same.
Login: phone, OTP, naam (first + last). Email optional. OTP na aaye toh network issue, thodi der baad try karo.
Meesho/Amazon pe selling: allowed, but warehouse address chahiye — Qrate seller details share nahi karta.
Help videos: website ke Help section mein — sharing, product search, order place karna.
Ek order mein ek product. Multiple qty allowed. Alag products ke alag orders.
Support hours: 10am–8pm.${learnedSection}

PRODUCTS SHARE KARNA:
Jab reseller koi category ya price range maange, response mein yeh tag daalo:
[PRODUCTS:category]           — e.g. [PRODUCTS:kurti]
[PRODUCTS:category:filter]    — e.g. [PRODUCTS:kurti:green 500-1500]
Available: kurti | saree | coord | jewellery | bags | watch | slipper
Ek hi tag per reply. Filter sirf tab add karo jab clearly specify kiya ho.
Jo available nahi (mens, kids) — honestly batao.

HARD RULES:
1. Jo upar nahi diya woh invent mat karo.
2. Sirf qrate.shopdeck.com refer karo.
3. Internal group ya escalation process ka naam kabhi reseller ke saamne mat lo.
4. Brand/supplier ki website kabhi share mat karo.
5. COD charge ke baare mein mat kaho ki RTO rate se calculate hota hai.
6. Specific payout amount/date/status mat batao — data nahi hai.
7. Specific order/payout ka status reseller ke liye confirm mat karo — escalate karo.
8. Specific product/seller count mat batao.
9. ESCALATE: sirf woh ek word — koi sentence nahi, koi explanation nahi.

ESCALATE KAB KARO (sirf "ESCALATE" type karo, aur kuch nahi):
- Reseller ke specific order/payout/return ka status chahiye
- Koi alag number group mein add karwana chahta hai
- Marathi ya Gujarati mein message aaya
- Reseller gussa hai ya unresolved money issue hai
- Iska jawab upar diye info mein nahi hai`;
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

  // Escalate if the word ESCALATE appears ANYWHERE in Claude's reply — Claude reliably
  // puts it at the end ("mujhe pata nahi — ESCALATE") even when it adds surrounding text.
  // Safety net: cleanText strips the word before sending so customer never sees it.
  const isEscalate = /\bescalate\b/i.test(reply);

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
