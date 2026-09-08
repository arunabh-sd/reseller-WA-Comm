import client from "./client/whatsapp.js";
import { pickSlotProducts } from "./ranking.js";
import { recordShared } from "./history.js";
import { SUBCATEGORY_LABELS } from "./config/categories.js";

const GROUP_NAME = process.env.WA_COMMUNITY_GROUP_NAME || "ShopDeck Resellers";

let cachedGroupJid = null;

async function getGroupJid() {
  if (cachedGroupJid) return cachedGroupJid;
  const group = await client.findGroupByName(GROUP_NAME);
  if (!group) throw new Error(`Group "${GROUP_NAME}" not found — check WA_COMMUNITY_GROUP_NAME`);
  cachedGroupJid = group.id;
  return cachedGroupJid;
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
    if (daysAway >= 0 && daysAway <= 28) return f;
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
  const subCatLabel = SUBCATEGORY_LABELS[products[0]?.clean_product_type] || slot.category;
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

  const groupJid = await getGroupJid();

  // 1. Quick image burst → WA auto-albums them
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    if (p.img_link) {
      try {
        const response = await fetch(p.img_link);
        if (response.ok) {
          const buffer = Buffer.from(await response.arrayBuffer());
          await client.sock.sendMessage(groupJid, { image: buffer, mimetype: "image/jpeg" });
        }
      } catch (e) {
        console.warn(`Image fetch failed for ${p.product_name}:`, e.message);
      }
    }
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 200));
  }

  // 2. Brief pause so album renders first
  await new Promise((r) => setTimeout(r, 1500));

  // 3. One combined text
  await client.sendTextMessage(groupJid, buildCombinedText(products, slot));

  recordShared(products, slot);

  const label = SUBCATEGORY_LABELS[products[0]?.clean_product_type] || "?";
  console.log(`✓ [${slot.hour}:${String(slot.minute||0).padStart(2,"0")}] ${slot.category} | ${products.length} products | ${label}`);
}
