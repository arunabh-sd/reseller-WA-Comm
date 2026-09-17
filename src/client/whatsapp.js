import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import { Writable } from "stream";
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
// Show Baileys' internal warnings/errors (pino level "warn") so we can see what
// fails during DM decryption — but filter out the high-frequency Bad MAC errors
// from group broadcast recipients to avoid Railway's 500 log/sec rate limit.
const _pinoFilter = new Writable({
  write(chunk, enc, cb) {
    const s = chunk.toString();
    // Only filter the high-frequency Bad MAC flood; everything else (including
    // per-JID decryption errors) must come through so we can diagnose DM failures.
    if (!s.includes("Bad MAC") && !s.includes("bad mac") && !s.includes("bad_mac")) {
      process.stdout.write(s);
    }
    cb();
  }
});
const logger = pino({ level: "warn" }, _pinoFilter);

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

  // On first startup, clear stale session state so Signal sessions are fresh.
  //
  // sender-key-memory-* → cleared always (stale = "Waiting for this message" in groups).
  // session-*           → cleared always (stale = Bad MAC on incoming DMs, which is the
  //                       exact breakage we have: bot can send but can't receive replies).
  //                       Signal's pre-key exchange re-establishes sessions automatically
  //                       on the next message; the contacts' phones handle it transparently.
  // creds.json          → PRESERVED — identity (no QR rescan needed).
  // sender-key-*        → PRESERVED — group key chains.
  _cleanStaleSessions() {
    try {
      const files = fs.readdirSync(AUTH_DIR);
      let mem = 0, sess = 0;
      for (const file of files) {
        if (file.startsWith("sender-key-memory-")) {
          fs.unlinkSync(`${AUTH_DIR}/${file}`);
          mem++;
        } else if (file.startsWith("session-")) {
          fs.unlinkSync(`${AUTH_DIR}/${file}`);
          sess++;
        }
      }
      if (mem)  console.log(`[WhatsApp] Cleared ${mem} sender-key-memory files → group redistribution`);
      if (sess) console.log(`[WhatsApp] Cleared ${sess} DM session files → fresh Signal sessions`);
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

    // Dedup by message ID — both ev.process and ev.on may fire for the same message.
    // Using both gives us a diagnostic signal: if ev.process fires but ev.on doesn't,
    // the bug is in Baileys' ev.on wrapper. Messages are processed exactly once.
    const _processedIds = new Set();
    const _handleBatch = (messages, type, src) => {
      const dmCount = messages.filter(m => !m.key.remoteJid?.endsWith("@g.us")).length;
      if (dmCount > 0) {
        console.log(`[WA] upsert [${src}]: type=${type} total=${messages.length} DMs=${dmCount}`);
      }

      for (const msg of messages) {
        const jid = msg.key.remoteJid;

        // Log EVERY DM — BEFORE fromMe check — to catch the @lid fromMe bug
        if (!jid?.endsWith("@g.us")) {
          console.log(`[WA] recv [${src}] type=${type} jid=${jid} fromMe=${msg.key.fromMe} decrypted=${!!msg.message}`);
        }

        if (msg.key.fromMe) continue;

        // Dedup — both handlers may see the same message
        const msgId = msg.key.id;
        if (_processedIds.has(msgId)) continue;
        _processedIds.add(msgId);
        if (_processedIds.size > 300) {
          _processedIds.delete(_processedIds.values().next().value);
        }

        // For DMs: accept notify, append (recent), relay, and any other real-time types.
        // "relay" is used in multi-device when a companion device delivers the message.
        // For groups: only "notify" (avoid replaying history after reconnect).
        const isDM = jid && !jid.endsWith("@g.us");
        if (isDM) {
          if (type === "append") {
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
          msg.message.ephemeralMessage?.message?.extendedTextEffect?.text ||
          ""
        ).trim();
        if (text) this.emit("message", { jid, text, key: msg.key });
      }
    };

    // ev.process — Baileys' lower-level batch handler, fires before ev.on listeners
    if (typeof this.sock.ev.process === "function") {
      this.sock.ev.process(async (events) => {
        if (events["messages.upsert"]) {
          const { messages, type } = events["messages.upsert"];
          _handleBatch(messages, type, "proc");
        }
      });
    }

    // ev.on — standard listener. If this fires but proc doesn't (or vice versa),
    // it narrows which layer of Baileys has the bug.
    this.sock.ev.on("messages.upsert", ({ messages, type }) => {
      _handleBatch(messages, type, "on");
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
