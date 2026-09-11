import client from "./client/whatsapp.js";
import { pickSlotProducts } from "./ranking.js";
import { recordShared } from "./history.js";
import { SUBCATEGORY_LABELS } from "./config/categories.js";
import { PRODUCTS_PER_SHARE } from "./config/schedule.js";

// Hardcoded target JIDs (from /debug/groups)
const COMMUNITY_JIDS = [
  "120363410134784350@g.us", // Resellers - QRate By Shopdeck (community sub-group)
  "120363428254767701@g.us", // Resellers - QRate By Shopdeck - 2 (community sub-group)
];
const ALL_JIDS = [
  ...COMMUNITY_JIDS,
  "120363411903988006@g.us", // Shopdeck - Focus Group - Reseller Channel
];

async function getTargetJids(communitiesOnly = false) {
  return communitiesOnly ? COMMUNITY_JIDS : ALL_JIDS;
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

// ── Image fetch with timeout + content-type guard + single retry ──────────────
// All retries happen here, BEFORE any WA send — never re-send to communities
async function fetchImage(url, attempt = 1) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[img] HTTP ${res.status} for ${url.slice(0, 80)}`);
      return null;
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) {
      console.warn(`[img] Non-image content-type "${ct}" — skipping ${url.slice(0, 80)}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) {
      console.warn(`[img] Suspiciously small buffer (${buf.length}B) — skipping ${url.slice(0, 80)}`);
      return null;
    }
    return buf;
  } catch (err) {
    clearTimeout(timer);
    if (attempt === 1) {
      console.warn(`[img] Fetch failed (attempt 1), retrying: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1500));
      return fetchImage(url, 2);
    }
    console.warn(`[img] Failed after retry — dropping image: ${url.slice(0, 80)}`);
    return null;
  }
}

// ── Main send ─────────────────────────────────────────────────────────────────
export async function sendSlot(slot, communitiesOnly = false) {
  const slotTag = `${slot.hour}:${String(slot.minute || 0).padStart(2, "0")}`;

  // Fetch a 5× pool so we can replace products whose images fail
  const candidates = await pickSlotProducts(slot, PRODUCTS_PER_SHARE * 5);

  if (!candidates.length) {
    console.log(`[Slot ${slotTag}] No eligible ${slot.category} products — skipping`);
    return;
  }

  const targetJids = await getTargetJids(communitiesOnly);

  // Fetch images for all candidates in parallel — BEFORE any WA sends
  const fetched = await Promise.all(
    candidates.map(async (p) => ({
      product: p,
      buffer:  p.img_link ? await fetchImage(p.img_link) : null,
    }))
  );

  // Prefer products that have a valid image; fill remainder from those without
  const withImage    = fetched.filter(x => x.buffer);
  const withoutImage = fetched.filter(x => !x.buffer);

  const selected = [
    ...withImage.slice(0, PRODUCTS_PER_SHARE),
    ...withoutImage.slice(0, Math.max(0, PRODUCTS_PER_SHARE - withImage.length)),
  ].slice(0, PRODUCTS_PER_SHARE);

  if (!selected.length) {
    console.log(`[Slot ${slotTag}] No products after selection — skipping`);
    return;
  }

  const products = selected.map(x => x.product);
  const buffers  = selected.map(x => x.buffer);

  console.log(`[Slot ${slotTag}] candidates: ${candidates.length} | with image: ${withImage.length} | selected: ${products.length}`);

  const text = buildCombinedText(products, slot);

  // Send to each target
  for (const jid of targetJids) {
    // 1. Quick image burst → WA auto-albums them
    for (let i = 0; i < products.length; i++) {
      if (buffers[i]) {
        try {
          await client.sock.sendMessage(jid, { image: buffers[i], mimetype: "image/jpeg" });
        } catch (imgErr) {
          console.warn(`[Slot] Image ${i} send failed for ${jid}: ${imgErr.message}`);
        }
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
  console.log(`✓ [${slotTag}] ${slot.category} | ${products.length} products | ${label}`);
}
