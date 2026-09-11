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

const AUTH_DIR = process.env.AUTH_DIR || "auth";
const logger = pino({ level: "silent" }); // Baileys internal logs off

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
    this._loadMsgStore();
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
      if (type !== "notify") return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;
        const text = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          ""
        ).trim();
        if (text) this.emit("message", { jid: msg.key.remoteJid, text, key: msg.key });
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
