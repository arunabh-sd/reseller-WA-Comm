import client from "./client/whatsapp.js";
import { pickSlotProducts } from "./ranking.js";
import { recordShared } from "./history.js";
import { SUBCATEGORY_LABELS } from "./config/categories.js";
import { PRODUCTS_PER_SHARE } from "./config/schedule.js";

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

function formatOrders(n) {
  if (!n || n < 10) return null;
  if (n >= 10000) return `${(n / 1000).toFixed(0)}k+`;
  if (n >= 1000)  return `${(n / 1000).toFixed(1)}k+`;
  return `${n}+`;
}

function formatPrice(n) {
  if (!n) return "";
  return `₹${Number(n).toLocaleString("en-IN")}`;
}

// ── Per-product message formatter ─────────────────────────────────────────────
// Mirrors exactly the format the user shared.
// All optional fields (has_video, sizes, myntra_*, website_*) come from the query.
function formatProductCaption(p) {
  const lines = [];

  // Title
  lines.push(`*${p.product_name || p.sharable_desc?.slice(0, 100) || "Product"}*`);
  lines.push("");

  // Description
  if (p.sharable_desc) {
    lines.push(p.sharable_desc);
    lines.push("");
  }

  // Price: ~MRP~ discounted
  const mrp   = formatPrice(p.mrp);
  const price = formatPrice(p.reseller_selling_price);
  if (mrp && price && p.mrp !== p.reseller_selling_price) {
    lines.push(`*~${mrp}~ ${price}*`);
  } else if (price) {
    lines.push(`*${price}*`);
  }
  lines.push("");

  // Video badge (only if explicitly flagged in query)
  if (p.has_video) {
    lines.push("*Actual customer review video added*");
    lines.push("");
  }

  // Sizes (expected as comma-separated string from query, e.g. "S/36, M/38, L/40")
  if (p.sizes) {
    lines.push(`Sizes: ${p.sizes}`);
    lines.push("");
  }

  // Social proof + trust signals
  const ordersLabel = formatOrders(p.l30d_orders || p.lifetime_orders);
  if (ordersLabel) lines.push(`*${ordersLabel}* orders already placed`);
  lines.push("Free delivery");
  lines.push("COD Available");
  lines.push("Return available");
  lines.push("Delivery in 4 to 7 days");
  lines.push("");

  // Price comparisons (from query — all optional)
  if (p.myntra_price && p.reseller_selling_price && p.myntra_price > p.reseller_selling_price) {
    const saving = formatPrice(p.myntra_price - p.reseller_selling_price);
    const link   = p.myntra_url ? ` (Check here: ${p.myntra_url})` : "";
    lines.push(`Cheaper than Myntra by ${saving}${link}`);
  }
  if (p.website_price && p.reseller_selling_price && p.website_price > p.reseller_selling_price) {
    const saving = formatPrice(p.website_price - p.reseller_selling_price);
    const link   = p.website_url ? ` (Check here: ${p.website_url})` : "";
    lines.push(`Cheaper than brand website by ${saving}${link}`);
  }
  if (p.myntra_price || p.website_price) lines.push("");

  // Product link
  const url = p.product_url || p.qrate_url || "";
  if (url) lines.push(`*Product link* 🔗 ${url}`);

  return lines.join("\n");
}

// ── Slot header message ────────────────────────────────────────────────────────
function formatSlotHeader(products, slot) {
  const subCat = products[0]?.clean_product_type || "";
  const label  = SUBCATEGORY_LABELS[subCat] || slot.category;
  return `🛍️ *Today's ${label}* — Bestsellers for you`;
}

// ── Main send function ────────────────────────────────────────────────────────
// Each product in the slot gets its own image+caption message, sent back-to-back.
export async function sendSlot(slot) {
  const products = await pickSlotProducts(slot, PRODUCTS_PER_SHARE);

  if (!products.length) {
    console.log(`[Sender] No eligible products for slot ${slot.hour}h ${slot.category} — skipping`);
    return;
  }

  const groupJid = await getGroupJid();

  // Opening header
  await client.sendTextMessage(groupJid, formatSlotHeader(products, slot));
  await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));

  // Send each product as its own image+caption
  for (let i = 0; i < products.length; i++) {
    const p       = products[i];
    const caption = formatProductCaption(p);

    // Human-like delay between products: 3–7s
    if (i > 0) await new Promise((r) => setTimeout(r, 3000 + Math.random() * 4000));

    if (p.image_url) {
      await client.sendImageMessage(groupJid, p.image_url, caption);
    } else {
      await client.sendTextMessage(groupJid, caption);
    }
  }

  recordShared(products, slot);

  console.log(
    `✓ Slot ${slot.hour}h | ${slot.category} | ` +
    `${products.length} products sent | ` +
    `sub-cat: ${SUBCATEGORY_LABELS[products[0]?.clean_product_type] || "?"}`
  );
}
