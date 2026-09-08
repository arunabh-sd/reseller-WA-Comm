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

// ── Combined text message for all products ────────────────────────────────────
function buildCombinedText(products, slot) {
  const label = SUBCATEGORY_LABELS[products[0]?.clean_product_type] || slot.category;
  const lines = [];

  lines.push(`🛍️ *${label}* — Today's Bestsellers`);
  lines.push("");

  products.forEach((p, i) => {
    lines.push(`${NUMBERS[i] || `${i + 1}.`} *${p.product_name}*`);

    // Cut price = website price if higher, else no strikethrough
    const sellerPrice = p.reseller_selling_price || 0;
    const cutPrice = p.website_price && p.website_price > sellerPrice ? p.website_price : null;
    lines.push(cutPrice ? `~${fmt(cutPrice)}~ *${fmt(sellerPrice)}*` : `*${fmt(sellerPrice)}*`);

    if (p.sizes) lines.push(`Sizes: ${p.sizes}`);
    if (p.has_video) lines.push(`🎥 Customer review video`);
    lines.push(`🔗 ${p.qrate_url}`);
    lines.push("");
  });

  // Shared trust signals
  const totalOrders = products.reduce((s, p) => s + (p.orders_last_30d || 0), 0);
  const ordersLabel = fmtOrders(totalOrders);
  if (ordersLabel) lines.push(`📦 *${ordersLabel}* orders already placed`);
  lines.push("✅ Free delivery · COD Available · Returns");
  lines.push("🚚 Delivery in 4 to 7 days");

  return lines.join("\n");
}

// ── Main send ─────────────────────────────────────────────────────────────────
export async function sendSlot(slot) {
  const products = await pickSlotProducts(slot);

  if (!products.length) {
    console.log(`[Slot ${slot.hour}h] No eligible ${slot.category} products — skipping`);
    return;
  }

  const groupJid = await getGroupJid();

  // 1. Send images as quick burst → WA auto-groups them into an album
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
        console.warn(`[Slot ${slot.hour}h] Image fetch failed for ${p.product_name}:`, e.message);
      }
    }
    // Short delay between images — quick enough that WA groups them as album
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 200));
  }

  // 2. Brief pause before text so album renders first
  await new Promise((r) => setTimeout(r, 1500));

  // 3. One combined text with all details + individual links
  const text = buildCombinedText(products, slot);
  await client.sendTextMessage(groupJid, text);

  recordShared(products, slot);

  console.log(
    `✓ [${slot.hour}:00] ${slot.category} | ` +
    `${products.length} products | ` +
    `sub-cat: ${SUBCATEGORY_LABELS[products[0]?.clean_product_type] || "?"}`
  );
}
