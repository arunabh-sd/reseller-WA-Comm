import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import { EventEmitter } from "events";
import fs from "fs";

// DATA_DIR always wins — guarantees auth lands on the Railway volume even if
// AUTH_DIR env var is set to an ephemeral path like /app/auth.
const AUTH_DIR = process.env.DATA_DIR
  ? `${process.env.DATA_DIR}/auth`
  : (process.env.AUTH_DIR || "auth");
// Suppress Baileys' direct stderr writes (Bad MAC decrypt errors from group
// broadcast recipients) — they bypass pino and hit Railway's 500 log/sec
// rate limit, drowning out every real diagnostic log line.
const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  const s = typeof chunk === "string" ? chunk : chunk.toString();
  if (s.includes("Bad MAC") || s.includes("Failed to decrypt") ||
      s.includes("decrypt message") || s.includes("Error decrypting")) return true;
  return _origStderrWrite(chunk, ...args);
};
const logger = pino({ level: "silent" }); // Baileys internal pino logs off

// Persist sent messages across Railway redeploys so retransmission works without "." fallback
const MSGSTORE_PATH = process.env.DATA_DIR
  ? `${process.env.DATA_DIR}/msgstore.json`
  : "/app/data/msgstore.json";

class WhatsAppClient extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.isReady = false;
    this.latestQR = null;
    this._msgStore = new Map(); // id → message content, for retransmission
    this._persistTimer = null;
    this._sessionsCleaned = false;
    this._loadMsgStore();
  }

  // On first startup, clear sender-key-memory only.
  //
  // sender-key-memory-* → Baileys' record of which group members received the sender key
  //                       distribution. Stale memory causes Baileys to skip redistribution
  //                       → "Waiting for this message" in broadcast groups. Clearing forces
  //                       full redistribution on the next send.
  //
  // session-*           → pairwise DM Signal sessions — PRESERVED. Clearing them breaks
  //                       existing DM sessions: contacts who message us before we message
  //                       them back get Bad MAC loops because their phone still encrypts
  //                       with the old session key. The getMessage callback (returning
  //                       stored content or "." as fallback) handles DM "Waiting" correctly.
  // creds.json          → PRESERVED — identity (no QR rescan).
  // sender-key-*        → PRESERVED — actual key chains (re-distribute same key, not new).
  _cleanStaleSessions() {
    try {
      const files = fs.readdirSync(AUTH_DIR);
      let cleared = 0;
      for (const file of files) {
        if (!file.startsWith("sender-key-memory-")) continue;
        fs.unlinkSync(`${AUTH_DIR}/${file}`);
        cleared++;
      }
      if (cleared > 0) {
        console.log(`[WhatsApp] Cleared ${cleared} sender-key-memory files → group key redistribution`);
      }
    } catch (e) {
      if (e.code !== "ENOENT") console.warn("[WhatsApp] Session clean failed:", e.message);
    }
  }

  _loadMsgStore() {
    try {
      const data = JSON.parse(fs.readFileSync(MSGSTORE_PATH, "utf8"));
      for (const [k, v] of Object.entries(data)) this._msgStore.set(k, v);
      console.log(`[WhatsApp] Restored ${this._msgStore.size} messages for retransmission`);
    } catch {
      // File doesn't exist yet — start fresh, no problem
    }
  }

  _saveMsgStore() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      try {
        fs.writeFileSync(MSGSTORE_PATH, JSON.stringify(Object.fromEntries(this._msgStore)));
      } catch (e) {
        console.warn("[WhatsApp] Failed to persist msgstore:", e.message);
      }
    }, 1000);
  }

  // Store a sent message so it can be retransmitted if receiver can't decrypt it.
  // Persisted to disk so retransmission survives Railway redeploys.
  registerSentMsg(id, content) {
    this._msgStore.set(id, content);
    if (this._msgStore.size > 500) {
      this._msgStore.delete(this._msgStore.keys().next().value);
    }
    this._saveMsgStore();
  }

  async connect() {
    // Only on first startup — not on auto-reconnects
    if (!this._sessionsCleaned) {
      this._sessionsCleaned = true;
      console.log(`[WhatsApp] Auth dir: ${AUTH_DIR}`);
      this._cleanStaleSessions();
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      browser: ["ShopDeck Broadcaster", "Chrome", "1.0.0"],
      // Return stored message for retransmission — lets receiver decrypt properly.
      // Fallback to "." so WhatsApp can always clear "waiting" state even for
      // messages sent before this process started (e.g. after a Railway redeploy).
      getMessage: async (key) => this._msgStore.get(key.id) ?? { conversation: "." },
    });

    this.sock.ev.on("creds.update", saveCreds);

    // Forward incoming messages so other modules can react (e.g. "Yes" for pending changes)
    this.sock.ev.on("messages.upsert", ({ messages, type }) => {
      // Fire for EVERY upsert so we know the event reaches us at all
      const dmCount = messages.filter(m => !m.key.remoteJid?.endsWith("@g.us")).length;
      if (dmCount > 0) {
        console.log(`[WA] upsert fired: type=${type} total=${messages.length} DMs=${dmCount}`);
      }

      for (const msg of messages) {
        const jid = msg.key.remoteJid;

        // Log EVERY DM message — BEFORE fromMe check — to catch the @lid fromMe bug
        if (!jid?.endsWith("@g.us")) {
          console.log(`[WA] recv type=${type} jid=${jid} fromMe=${msg.key.fromMe} decrypted=${!!msg.message}`);
        }

        if (msg.key.fromMe) continue;

        // For DMs: accept notify, append (recent), relay, and any other real-time types.
        // "relay" is used in multi-device when a companion device delivers the message.
        // For groups: only "notify" (avoid replaying history after reconnect).
        const isDM = jid && !jid.endsWith("@g.us");
        if (isDM) {
          if (type === "append") {
            // Skip old history but accept recent appends
            const ts = (msg.messageTimestamp || 0) * 1000;
            if (Date.now() - ts > 5 * 60 * 1000) continue;
          }
          // else: accept notify, relay, and anything else for DMs
        } else {
          if (type !== "notify") continue;
        }

        if (!msg.message) continue;
        const text = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.ephemeralMessage?.message?.conversation ||
          msg.message.ephemeralMessage?.message?.extendedTextMessage?.text ||
          ""
        ).trim();
        if (text) this.emit("message", { jid, text, key: msg.key });
      }
    });

    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.latestQR = qr;
        this.emit("qr", qr);
      }

      if (connection === "open") {
        this.isReady = true;
        this.latestQR = null;
        this.emit("ready");
        console.log("✓ WhatsApp connected");
      }

      if (connection === "close") {
        this.isReady = false;
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;

        console.log(`WhatsApp disconnected (code ${code}), reconnecting: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(() => this.connect(), 5000);
        } else {
          console.error("Logged out — rescan QR to reconnect");
          this.emit("logged_out");
        }
      }
    });
  }

  async findGroupByName(name) {
    if (!this.sock) throw new Error("Not connected");
    const groups = await this.sock.groupFetchAllParticipating();
    const match = Object.values(groups).find(
      (g) => g.subject?.trim().toLowerCase() === name.trim().toLowerCase()
    );
    return match || null;
  }

  // Find the "Announcements" sub-group inside a WhatsApp community
  async findCommunityAnnouncements(communityName) {
    if (!this.sock) throw new Error("Not connected");
    const groups = await this.sock.groupFetchAllParticipating();
    const all = Object.values(groups);

    // The community itself appears as a group in the list
    const community = all.find(
      (g) => g.subject?.trim().toLowerCase() === communityName.trim().toLowerCase()
    );
    if (!community) {
      console.warn(`[WA] Community not found: "${communityName}"`);
      return null;
    }

    // Sub-groups linked to this community have linkedParent === community.id
    const announcements = all.find(
      (g) =>
        g.linkedParent === community.id &&
        g.subject?.trim().toLowerCase() === "announcements"
    );
    if (!announcements) {
      console.warn(`[WA] No Announcements sub-group found in "${communityName}"`);
    }
    return announcements || null;
  }

  async sendImageMessage(groupJid, imageUrl, caption) {
    if (!this.isReady) throw new Error("WhatsApp not ready");

    // Fetch image buffer from URL
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Failed to fetch image: ${imageUrl}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    await this.sock.sendMessage(groupJid, {
      image: buffer,
      caption,
      mimetype: "image/jpeg",
    });
  }

  async sendTextMessage(jid, text) {
    if (!this.isReady) throw new Error("WhatsApp not ready");
    const result = await this.sock.sendMessage(jid, { text });
    if (result?.key?.id) this.registerSentMsg(result.key.id, { conversation: text });
    return result;
  }
}

// Singleton
const client = new WhatsAppClient();
export default client;
