import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import { EventEmitter } from "events";

const AUTH_DIR = process.env.AUTH_DIR || "auth";
const logger = pino({ level: "silent" }); // Baileys internal logs off

class WhatsAppClient extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.isReady = false;
    this.latestQR = null;
    this._msgStore = new Map(); // id → message content, for retransmission
  }

  // Store a sent message so it can be retransmitted if receiver can't decrypt it.
  // Without this, Baileys responds to retransmission requests with undefined → wrong message shown.
  registerSentMsg(id, content) {
    this._msgStore.set(id, content);
    if (this._msgStore.size > 500) {
      this._msgStore.delete(this._msgStore.keys().next().value);
    }
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
      // Return original message content on retransmission requests so receiver
      // can decrypt. Without this (or with a wrong value like "."), receivers
      // see "Waiting for this message" or get a spurious "." message.
      getMessage: async (key) => this._msgStore.get(key.id),
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
