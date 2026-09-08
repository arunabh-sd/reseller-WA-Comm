import client from "./client/whatsapp.js";
import { pickSlotProducts } from "./ranking.js";
import { recordShared } from "./history.js";
import { SUBCATEGORY_LABELS } from "./config/categories.js";

// Targets (resolved once, then cached)
const TARGET_GROUP      = process.env.WA_GROUP_NAME      || "";
const TARGET_COMMUNITY_1 = process.env.WA_COMMUNITY_1   || "";
const TARGET_COMMUNITY_2 = process.env.WA_COMMUNITY_2   || "";

let cachedTargetJids = null;

async function getTargetJids() {
  if (cachedTargetJids) return cachedTargetJids;

  const jids = [];

  if (TARGET_COMMUNITY_1) {
    const g = await client.findCommunityAnnouncements(TARGET_COMMUNITY_1);
    if (g) jids.push(g.id);
    else console.warn(`[Sender] Announcements not found in community: ${TARGET_COMMUNITY_1}`);
  }
  if (TARGET_COMMUNITY_2) {
    const g = await client.findCommunityAnnouncements(TARGET_COMMUNITY_2);
    if (g) jids.push(g.id);
    else console.warn(`[Sender] Announcements not found in community: ${TARGET_COMMUNITY_2}`);
  }
  if (TARGET_GROUP) {
    const g = await client.findGroupByName(TARGET_GROUP);
    if (g) jids.push(g.id);
    else console.warn(`[Sender] Group not found: ${TARGET_GROUP}`);
  }

  if (!jids.length) throw new Error("No valid WA targets found — check WA_GROUP_NAME / WA_COMMUNITY_1 / WA_COMMUNITY_2");
  cachedTargetJids = jids;
  console.log(`[Sender] Resolved ${jids.length} target(s):`, jids);
  return jids;
}

// ── Festival calendar ─────────────────────────────────────────────────────────
// Show tag when within 28 days before the festival start
const FESTIVALS = [
  { name: "Navratri",  emoji: "🪷", start: "2026-10-02", categories: ["kurti","saree","jewellery"] },
  { name: "Dussehra",  emoji: "🏹", start: "2026-10-12", categories: ["kurti","saree"] },
  { name: "Diwali",    emoji: "🪔", start: "2026-11-01", categories: ["kurti","saree","jewellery","western","bags"] },
  { name: "Holi",      emoji: "🎨", start: "2027-03-14", categories: ["kurti","western"] },
  { name: "Eid",       emoji: "🌙", start: "2027-03-30", categories: ["kurti","saree"] },
];

function getActiveFestival(category) {
  const today = new Date();
  for (const f of FESTIVALS) {
    if (!f.categories.includes(category)) continue;
    const start = new Date(f.start);
    const daysAway = (start - today) / 86400000;
    if (daysAway >= 0 && daysAway <= 10) return f;
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) {
  if (!n) return "";
  return `₹${Number(n).toLocaleString("en-IN")}`;
}

function fmtOrders(n) {
  if (!n || n < 10) return null;
  if (n >= 10000) return `${(n / 1000).toFixed(0)}k+`;
  if (n >= 1000)  return `${(n / 1000).toFixed(1)}k+`;
  return `${n}+`;
}

const NUMBERS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];

// ── Combined text message ─────────────────────────────────────────────────────
function buildCombinedText(products, slot) {
  const subCatLabel = products[0]?.category_l2 || SUBCATEGORY_LABELS[products[0]?.clean_product_type] || slot.category;
  const isPremium   = slot.aovBucket === "high";
  const festival    = getActiveFestival(slot.category);

  // Header
  const label    = isPremium ? `💎 Premium ${subCatLabel}` : subCatLabel;
  const occasion = festival ? `${festival.name} Collection ${festival.emoji}` : "Today's Bestsellers";
  const lines    = [`🛍️ *${label}* — ${occasion}`, ""];

  // Per-product block
  products.forEach((p, i) => {
    lines.push(`${NUMBERS[i] || `${i + 1}.`} *${p.product_name}*`);

    // Cut price = website price (always exists per user)
    const sellerPrice = p.reseller_selling_price || 0;
    lines.push(`~${fmt(p.website_price)}~ *${fmt(sellerPrice)}*`);

    // Orders
    const ordersLabel = fmtOrders(p.orders_last_30d);
    const ordersPart  = ordersLabel ? `📦 ${ordersLabel} orders` : null;

    // Trust signal — exclusive > marketplace saving
    let trust = null;
    if (p.exclusive) {
      trust = "Exclusive — not listed on any marketplace 🔒";
    } else if (p.mp_price && p.mp_price - sellerPrice >= 100) {
      const mpName = p.mp_name
        ? p.mp_name.charAt(0).toUpperCase() + p.mp_name.slice(1)
        : "Marketplace";
      trust = `${fmt(p.mp_price - sellerPrice)} cheaper than ${mpName}`;
    }

    // Orders + trust on same line if both exist, else separate
    if (ordersPart && trust) lines.push(`${ordersPart} · ${trust}`);
    else if (ordersPart)     lines.push(ordersPart);
    else if (trust)          lines.push(trust);

    if (p.sizes) lines.push(`Sizes: ${p.sizes}`);
    if (p.has_video) lines.push(`🎥 Customer review video`);
    lines.push(`🔗 ${p.qrate_url}`);
    lines.push("");
  });

  // Shared trust footer
  lines.push("✅ Free delivery · COD available · Easy returns");
  lines.push("🚚 Delivered in 4–7 days");

  return lines.join("\n");
}

// ── Main send ─────────────────────────────────────────────────────────────────
export async function sendSlot(slot) {
  const products = await pickSlotProducts(slot);

  if (!products.length) {
    console.log(`[Slot ${slot.hour}:${String(slot.minute||0).padStart(2,"0")}] No eligible ${slot.category} products — skipping`);
    return;
  }

  const targetJids = await getTargetJids();

  // Pre-fetch all images once (avoid re-fetching per target)
  const buffers = await Promise.all(
    products.map(async (p) => {
      if (!p.img_link) return null;
      try {
        const res = await fetch(p.img_link);
        return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
      } catch {
        return null;
      }
    })
  );

  const text = buildCombinedText(products, slot);

  // Send to each target
  for (const jid of targetJids) {
    // 1. Quick image burst → WA auto-albums them
    for (let i = 0; i < products.length; i++) {
      if (buffers[i]) {
        await client.sock.sendMessage(jid, { image: buffers[i], mimetype: "image/jpeg" });
      }
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 200));
    }
    // 2. Brief pause so album renders first
    await new Promise((r) => setTimeout(r, 1500));
    // 3. One combined text
    await client.sendTextMessage(jid, text);

    // Gap between targets to avoid flood detection
    if (targetJids.indexOf(jid) < targetJids.length - 1) {
      await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
    }
  }

  recordShared(products, slot);

  const label = products[0]?.category_l2 || SUBCATEGORY_LABELS[products[0]?.clean_product_type] || "?";
  console.log(`✓ [${slot.hour}:${String(slot.minute||0).padStart(2,"0")}] ${slot.category} | ${products.length} products | ${label}`);
}
