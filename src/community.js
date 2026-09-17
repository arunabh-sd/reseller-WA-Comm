import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import client from "./client/whatsapp.js";
import { TEST_GROUP_JID } from "./pending_changes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_PATH = path.join(__dirname, "../assets/intro.mp4");

let _videoBuffer = null;
function getVideoBuffer() {
  if (!_videoBuffer) {
    try {
      _videoBuffer = fs.readFileSync(VIDEO_PATH);
    } catch {
      console.warn("[Community] Welcome video not found:", VIDEO_PATH);
      return null;
    }
  }
  return _videoBuffer;
}

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

// group-participants.update does NOT fire for WhatsApp community parent JIDs.
// We poll groupMetadata every 30 min and diff against this snapshot instead.
const _memberSnapshot = new Map(); // communityJid → Set<participantJid>

function trackParticipantUpdate(groupJid, action, memberJids) {
  const data = getStore();

  for (const jid of memberJids) {
    if (action === "add") {
      if (!data.today[groupJid].joined.includes(jid)) {
        data.today[groupJid].joined.push(jid);
      }
      const alreadyQueued = data.pendingWelcome.some(e => e.memberJid === jid);
      if (!alreadyQueued && !_welcomedLids.has(jid)) {
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

// Call this on startup and every 30 min. On first run it just takes a baseline
// snapshot; subsequent runs diff and call trackParticipantUpdate for deltas.
export async function pollCommunityMembers() {
  for (const jid of COMMUNITY_JIDS) {
    try {
      const meta = await client.sock.groupMetadata(jid);
      const current = new Set(meta.participants.map(p => p.id));
      const prev = _memberSnapshot.get(jid);

      if (!prev) {
        _memberSnapshot.set(jid, current);
        console.log(`[Community] Snapshot: ${current.size} members in ${COMMUNITY_NAMES[jid] || jid}`);
        continue;
      }

      const joined = [...current].filter(id => !prev.has(id));
      const left   = [...prev].filter(id => !current.has(id));

      if (joined.length) trackParticipantUpdate(jid, "add", joined);
      if (left.length)   trackParticipantUpdate(jid, "remove", left);

      _memberSnapshot.set(jid, current);
    } catch (e) {
      console.warn(`[Community] Poll failed for ${jid}:`, e.message);
    }
  }
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

// LIDs we already welcomed this process lifetime — prevents double-welcoming
// after someone rejoins. Separate from DM conversations because @lid ≠ @s.whatsapp.net.
const _welcomedLids = new Set();

function isBusinessHours() {
  const hour = parseInt(
    new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false })
  );
  return hour >= 9 && hour < 20;
}

// onSent(jid, text) — called after each successful welcome send so bot.js can
// seed the conversation history. Note: @lid JID seeded here may not match the
// @s.whatsapp.net JID of subsequent replies — this is a WhatsApp limitation.
export async function processWelcomeQueue(onSent) {
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
    const welcomeMsg = buildWelcomeMessage(entry.groupJid);

    try {
      const videoBuffer = getVideoBuffer();
      if (videoBuffer) {
        await client.sock.sendMessage(entry.memberJid, {
          video: videoBuffer,
          mimetype: "video/mp4",
        });
        await new Promise(r => setTimeout(r, 1000));
      }
      await client.sendTextMessage(entry.memberJid, welcomeMsg);
      _welcomedLids.add(entry.memberJid);
      if (onSent) onSent(entry.memberJid, welcomeMsg);
      console.log(`[Community] Welcomed ${entry.memberJid}${videoBuffer ? " (with video)" : ""}`);
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
    } catch (e) {
      console.warn(`[Community] Welcome failed for ${entry.memberJid}:`, e.message);
    }
  }
}
