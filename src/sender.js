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

// ── Helpers ────────────────────────────────────────────────────────────────────

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

// ── Per-product caption ────────────────────────────────────────────────────────
function buildCaption(p) {
  const lines = [];

  // Title
  lines.push(`*${p.product_name}*`);
  lines.push("");

  // Description
  if (p.sharable_desc) {
    lines.push(p.sharable_desc);
    lines.push("");
  }

  // Price — strikethrough MRP if different from reseller price
  const mrp   = p.mrp && p.mrp !== p.reseller_selling_price ? fmt(p.mrp) : null;
  const price = fmt(p.reseller_selling_price);
  lines.push(mrp ? `*~${mrp}~ ${price}*` : `*${price}*`);
  lines.push("");

  // Video badge (field from query when available)
  if (p.has_video) {
    lines.push("*Actual customer review video added*");
    lines.push("");
  }

  // Sizes
  if (p.sizes) {
    lines.push(`Sizes: ${p.sizes}`);
    lines.push("");
  }

  // Social proof + trust
  const ordersLabel = fmtOrders(p.orders_last_30d);
  if (ordersLabel) lines.push(`*${ordersLabel}* orders already placed`);
  lines.push("Free delivery");
  lines.push("COD Available");
  lines.push("Return available");
  lines.push("Delivery in 4 to 7 days");
  lines.push("");

  // Price comparisons
  const sellerPrice = p.reseller_selling_price || 0;
  if (p.mp_price && p.mp_price > sellerPrice) {
    const saving  = fmt(p.mp_price - sellerPrice);
    const mpLabel = p.mp_name
      ? p.mp_name.charAt(0).toUpperCase() + p.mp_name.slice(1)
      : "Marketplace";
    const link = p.mp_link ? ` (Check here: ${p.mp_link})` : "";
    lines.push(`Cheaper than ${mpLabel} by ${saving}${link}`);
  }
  if (p.website_price && p.website_price > sellerPrice) {
    const saving = fmt(p.website_price - sellerPrice);
    const link   = p.website_product_link ? ` (Check here: ${p.website_product_link})` : "";
    lines.push(`Cheaper than brand website by ${saving}${link}`);
  }
  if ((p.mp_price && p.mp_price > sellerPrice) || (p.website_price && p.website_price > sellerPrice)) {
    lines.push("");
  }

  // Product link
  lines.push(`*Product link* 🔗 ${p.qrate_url}`);

  return lines.join("\n");
}

// ── Slot header ────────────────────────────────────────────────────────────────
function buildHeader(products, slot) {
  const label = SUBCATEGORY_LABELS[products[0]?.clean_product_type] || slot.category;
  return `🛍️ *${label}* — Today's Bestsellers`;
}

// ── Main send ─────────────────────────────────────────────────────────────────
export async function sendSlot(slot) {
  const products = await pickSlotProducts(slot);

  if (!products.length) {
    console.log(`[Slot ${slot.hour}h] No eligible ${slot.category} products — skipping`);
    return;
  }

  const groupJid = await getGroupJid();

  // Header message
  await client.sendTextMessage(groupJid, buildHeader(products, slot));
  await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));

  // One image+caption per product with human-like delays
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 3000 + Math.random() * 4000));

    const caption = buildCaption(p);

    if (p.img_link) {
      await client.sendImageMessage(groupJid, p.img_link, caption);
    } else {
      await client.sendTextMessage(groupJid, caption);
    }
  }

  recordShared(products, slot);

  console.log(
    `✓ [${slot.hour}:00] ${slot.category} | ` +
    `${products.length} products | ` +
    `sub-cat: ${SUBCATEGORY_LABELS[products[0]?.clean_product_type] || "?"} | ` +
    `scores: ${products.map((p) => p._score?.toFixed(2)).join(", ")}`
  );
}
