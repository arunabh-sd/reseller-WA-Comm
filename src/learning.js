import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getSharedOnDate } from "./history.js";
import { fetchPerformanceForDate } from "./metabase.js";
import { getProductMap } from "./cache.js";
import { savePending, TEST_GROUP_JID } from "./pending_changes.js";

const DATA_DIR         = process.env.DATA_DIR || "data";
const WEIGHTS_FILE     = join(DATA_DIR, "weights.json");
const SUBCAT_PERF_FILE = join(DATA_DIR, "subcategory_perf.json");

const SUBCAT_ALPHA = 0.3;

const DEFAULT_WEIGHTS = {
  l30d_orders:     0.40,
  margin:          0.25,
  l7d_views:       0.20,
  l7d_shares:      0.15,
  exclusive:       0.00,
  marketplace_gap: 0.00,
};

// ── Persistence ───────────────────────────────────────────────────────────────

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
function writeJson(path, data) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export function loadWeights() {
  return { ...DEFAULT_WEIGHTS, ...readJson(WEIGHTS_FILE, {}) };
}
export function loadSubcategoryPerf() {
  return readJson(SUBCAT_PERF_FILE, {});
}

// Card 14915 columns (confirmed from Metabase screenshot):
// customer_product_short_id, total_orders, total_ppo, total_shares
const F14915 = { id: "customer_product_short_id", orders: "total_orders", ppo: "total_ppo", shares: "total_shares" };

// ── Sub-category EMA update (runs automatically, no confirmation needed) ──────

function updateSubcategoryPerf(sharedEntries) {
  const bySub = {};
  for (const e of sharedEntries) {
    const sc = e.sub_category || "unknown";
    if (!bySub[sc]) bySub[sc] = [];
    bySub[sc].push(e.total_orders || 0);
  }
  const existing = loadSubcategoryPerf();
  for (const [sc, orderArr] of Object.entries(bySub)) {
    if (sc === "unknown") continue;
    const dayAvg = orderArr.reduce((s, v) => s + v, 0) / orderArr.length;
    const prev   = existing[sc];
    existing[sc] = prev
      ? { ema_orders: SUBCAT_ALPHA * dayAvg + (1 - SUBCAT_ALPHA) * prev.ema_orders, samples: prev.samples + orderArr.length }
      : { ema_orders: dayAvg, samples: orderArr.length };
  }
  writeJson(SUBCAT_PERF_FILE, existing);
}

// ── AI analysis via Claude ────────────────────────────────────────────────────

function productLine(p) {
  return `${p.product_name || p.product_id} | ${p.sub_category || "?"} | ₹${p.price || "?"} | ` +
         `${p.aov_bucket || "?"} AOV | ${p.exclusive ? "excl" : "std"} | ₹${p.margin || 0} margin | ` +
         `${p.total_orders}orders ${p.total_ppo}PPO ${p.total_shares}shares`;
}

function organicLine(r) {
  return `${r[F14915.id]} | ${r[F14915.orders] || 0}orders ${r[F14915.ppo] || 0}PPO ${r[F14915.shares] || 0}shares`;
}

async function callClaude(dateStr, sharedEntries, organicRows, currentWeights) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[Learning] ANTHROPIC_API_KEY not set — skipping AI analysis");
    return null;
  }

  const ordered     = sharedEntries.filter((p) => p.total_orders >= 1).sort((a, b) => b.total_orders - a.total_orders);
  const highShares  = sharedEntries.filter((p) => p.total_shares > 3).sort((a, b) => b.total_shares - a.total_shares);
  const highPPO     = sharedEntries.filter((p) => p.total_ppo > 10).sort((a, b) => b.total_ppo - a.total_ppo);
  const missed      = sharedEntries.filter((p) => p.total_orders < 1 && p.total_shares <= 3 && p.total_ppo <= 10);

  const organicHit  = organicRows.filter((r) =>
    (r[fields.orders] || 0) >= 1 || (r[fields.shares] || 0) > 3 || (r[fields.ppo] || 0) > 10
  ).sort((a, b) => (b[fields.orders] || 0) - (a[fields.orders] || 0));

  const prompt = `You are the analytics brain for ShopDeck's WhatsApp reseller broadcaster.
Yesterday (${dateStr}) we shared ${sharedEntries.length} products to ~3 reseller WA groups.

SHARED → GOT ≥1 ORDER (${ordered.length}):
${ordered.slice(0, 6).map(productLine).join("\n") || "none"}

SHARED → GOT >3 SHARES (${highShares.length}):
${highShares.slice(0, 4).map(productLine).join("\n") || "none"}

SHARED → GOT >10 PPO (${highPPO.length}):
${highPPO.slice(0, 4).map(productLine).join("\n") || "none"}

SHARED → MISSED ALL BUCKETS (${missed.length}):
${missed.slice(0, 5).map(productLine).join("\n") || "none"}

ORGANIC PERFORMERS — not shared by us, but hit a bucket (${organicHit.length}):
${organicHit.slice(0, 5).map(organicLine).join("\n") || "none"}

Current ranking weights: ${JSON.stringify(currentWeights, null, 2)}
(l7d_views = PPO weight; exclusive and marketplace_gap start at 0 and are learned)

Analyse patterns: price point, sub-category, exclusivity, margin, AOV bucket, and what organic performers suggest we're missing.

Reply in EXACTLY this format — keep it short, this goes on WhatsApp:

INSIGHTS:
• [pattern in high-performers vs misses — be specific about what worked]
• [insight about organic performers — what should we have shared but didn't?]
• [one more actionable finding]

RECOMMENDATION:
[Single sentence, max 20 words — what one thing should we change tomorrow?]

WEIGHT_JSON:
{"l30d_orders": 0.xx, "margin": 0.xx, "l7d_views": 0.xx, "l7d_shares": 0.xx, "exclusive": 0.xx, "marketplace_gap": 0.xx}
(all weights must sum to 1.0; only change if data is clear; keep existing if unsure)`;

  // Supports both direct Anthropic keys (sk-ant-...) and LiteLLM proxy keys.
  // Set ANTHROPIC_BASE_URL to your LiteLLM proxy URL when using a proxy key.
  const anthropic = new Anthropic({
    apiKey,
    ...(process.env.ANTHROPIC_BASE_URL && { baseURL: process.env.ANTHROPIC_BASE_URL }),
    defaultHeaders: { "x-litellm-api-key": apiKey },
  });
  const msg = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 700,
    messages:   [{ role: "user", content: prompt }],
  });

  return msg.content[0]?.text || null;
}

function parseAIResponse(text) {
  if (!text) return { insights: null, recommendation: null, weights: null };

  const insightsMatch     = text.match(/INSIGHTS:\s*([\s\S]*?)(?=RECOMMENDATION:|WEIGHT_JSON:|$)/i);
  const recommendMatch    = text.match(/RECOMMENDATION:\s*([^\n]+)/i);
  const weightJsonMatch   = text.match(/WEIGHT_JSON:\s*(\{[\s\S]*?\})/i);

  let weights = null;
  if (weightJsonMatch) {
    try {
      const parsed = JSON.parse(weightJsonMatch[1]);
      const total  = Object.values(parsed).reduce((s, v) => s + v, 0);
      // Accept if weights sum roughly to 1
      if (total > 0.95 && total < 1.05) {
        weights = {};
        for (const [k, v] of Object.entries(parsed)) weights[k] = +v.toFixed(4);
      } else {
        console.warn("[Learning] AI weight JSON doesn't sum to 1 — ignoring");
      }
    } catch {
      console.warn("[Learning] Failed to parse AI weight JSON");
    }
  }

  return {
    insights:       insightsMatch?.[1]?.trim()   || null,
    recommendation: recommendMatch?.[1]?.trim()  || null,
    weights,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runDailyLearning(client) {
  // Use IST date for "yesterday"
  const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const [y, m, d] = todayIST.split("-").map(Number);
  const dateStr   = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().split("T")[0]; // YYYY-MM-DD

  console.log(`[Learning] Evaluating IST date: ${dateStr}`);

  // 1. What we shared yesterday
  const sent = getSharedOnDate(dateStr);
  if (!sent.length) {
    console.log("[Learning] Nothing in shared_history for", dateStr);
    if (client?.isReady) {
      await client.sendTextMessage(TEST_GROUP_JID,
        `📊 *Daily Learning — ${dateStr}*\n\nNothing was shared yesterday.`);
    }
    return;
  }

  // 2. Fetch card 14915 — all products with performance for that date
  const perf14915 = await fetchPerformanceForDate(dateStr);
  console.log(`[Learning] 14915 rows: ${perf14915.length}`);

  // 3. Build perfMap: customer_product_short_id → row
  const perfMap = new Map(perf14915.map((r) => [String(r[F14915.id]), r]));

  // 4. Cross-reference shared products with 14915 (same ID field: customer_product_short_id)
  const sharedSet = new Set(sent.map((e) => String(e.product_id)));
  const sharedEntries = sent.map((e) => {
    const r = perfMap.get(String(e.product_id)) || {};
    return {
      ...e,
      total_orders: Number(r[F14915.orders] ?? 0),
      total_ppo:    Number(r[F14915.ppo]    ?? 0),
      total_shares: Number(r[F14915.shares] ?? 0),
    };
  });

  const matched = sharedEntries.filter((e) => e.total_orders > 0 || e.total_ppo > 0 || e.total_shares > 0).length;
  console.log(`[Learning] Shared: ${sharedEntries.length} | matched in 14915: ${matched}`);

  // 5. Organic performers: in 14915 but not shared by us, hit at least one bucket
  const organicRows = perf14915.filter((r) => {
    if (sharedSet.has(String(r[F14915.id]))) return false;
    return (r[F14915.orders] || 0) >= 1 || (r[F14915.shares] || 0) > 3 || (r[F14915.ppo] || 0) > 10;
  });
  console.log(`[Learning] Organic performers: ${organicRows.length}`);

  // 6. Update sub-category EMA (internal, no confirmation needed)
  updateSubcategoryPerf(sharedEntries);

  // 7. Call Claude for AI analysis
  const currentWeights = loadWeights();
  const aiText         = await callClaude(dateStr, sharedEntries, organicRows, currentWeights);
  const { insights, recommendation, weights: recommendedWeights } = parseAIResponse(aiText);

  // 9. Build summary message
  const ordered    = sharedEntries.filter((e) => e.total_orders >= 1).length;
  const highShares = sharedEntries.filter((e) => e.total_shares > 3).length;
  const highPPO    = sharedEntries.filter((e) => e.total_ppo > 10).length;

  const lines = [
    `📊 *Daily Learning — ${dateStr}*`,
    "",
    `*Shared:* ${sharedEntries.length} products`,
    `≥1 order: ${ordered} · >3 shares: ${highShares} · >10 PPO: ${highPPO}`,
    `Organic hits (not shared by us): ${organicRows.length}`,
    "",
  ];

  if (insights) {
    lines.push("*AI Insights:*");
    lines.push(insights);
    lines.push("");
  }
  if (recommendation) {
    lines.push(`*Recommendation:* ${recommendation}`);
    lines.push("");
  }
  if (recommendedWeights) {
    const changes = Object.keys(recommendedWeights)
      .filter((k) => Math.abs((recommendedWeights[k] || 0) - (currentWeights[k] || 0)) > 0.001)
      .map((k) => `${k}: ${(currentWeights[k] || 0).toFixed(3)} → ${recommendedWeights[k].toFixed(3)}`);
    if (changes.length) {
      lines.push(`*Proposed changes:* ${changes.join(" · ")}`);
      lines.push("");
      lines.push("Reply *Yes* to apply, or ignore to keep current settings.");
      savePending({ weights: recommendedWeights });
    } else {
      lines.push("*Weights:* no changes recommended.");
    }
  } else if (aiText) {
    lines.push("_(No weight changes parsed from AI response)_");
  }

  const summary = lines.join("\n");

  if (client?.isReady) {
    await client.sendTextMessage(TEST_GROUP_JID, summary);
    console.log("[Learning] Summary sent to Test group");
  } else {
    console.log("[Learning] Client not ready — summary:\n", summary);
  }
}
