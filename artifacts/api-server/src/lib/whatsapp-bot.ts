/**
 * WhatsApp Bot – All‑in‑One (Fully Working)
 */
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  downloadContentFromMessage,
  toBuffer,
  jidNormalizedUser,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import pino from "pino";
import { startSustainedTyping, showRecording } from "./features/presence";
import sharp from "sharp";

// ── Constants ──────────────────────────────────────────────────────────────
const BASE_DIR = path.join(process.cwd(), "data");
const MEDIA_DIR = path.join(BASE_DIR, "saved_media");
const CUSTOM_COMMANDS_FILE = path.join(BASE_DIR, "custom_commands.json");
fs.mkdirSync(MEDIA_DIR, { recursive: true });

export const CMD = ".";
const SESSIONS_FILE = path.join(BASE_DIR, "sessions_list.json");

function loadSessionIds(): { id: string; label: string }[] {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveSessionIds(list: { id: string; label: string }[]): void {
  try {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list, null, 2));
  } catch { /* ignore */ }
}

function registerSession(id: string, label: string): void {
  const list = loadSessionIds();
  if (!list.find(s => s.id === id)) {
    list.push({ id, label });
    saveSessionIds(list);
  }
}

function unregisterSession(id: string): void {
  const list = loadSessionIds().filter(s => s.id !== id);
  saveSessionIds(list);
}

// ── Session registry (must come before exports that use it) ───────────────
const sessions = new Map<string, any>();

function addLog(state: any, msg: string) {
  console.log(`[WA]`, msg);
}

// ── Exports for dashboard & API ──────────────────────────────────────────
export const botState = {
  get status() { return sessions.get("default")?.status ?? "disconnected"; },
  get qrDataUrl() { return sessions.get("default")?.qrDataUrl ?? null; },
  get phoneNumber() { return sessions.get("default")?.phoneNumber ?? null; },
  get savedFiles() { return []; },
  get log() { return []; },
};

export function getSock() { return sessions.get("default")?._sock ?? null; }

export function getAllSessions() {
  return Array.from(sessions.values()).map(s => ({
    id: s.id,
    label: s.label,
    status: s.status,
    qrDataUrl: s.qrDataUrl,
    phoneNumber: s.phoneNumber,
    savedFiles: s.savedFiles,
    log: s.log,
  }));
}

export function getSessionState(id: string) {
  const s = sessions.get(id);
  if (!s) return undefined;
  return {
    id: s.id,
    label: s.label,
    status: s.status,
    qrDataUrl: s.qrDataUrl,
    phoneNumber: s.phoneNumber,
    savedFiles: s.savedFiles,
    log: s.log,
  };
}

export function deleteSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  try { s._sock?.end(undefined); } catch { }
  unregisterSession(id);
  sessions.delete(id);
  const authDir = path.join(BASE_DIR, "sessions", id);
  registerSession(id, id);
  try { fs.rmSync(authDir, { recursive: true, force: true }); } catch { }
}

export function stopSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  s._stopRequested = true;
  try { s._sock?.end(undefined); } catch { }
  s._sock = null;
  s.status = "disconnected";
}

export async function requestPairingCode(id: string, phone: string): Promise<string> {
  const s = sessions.get(id);
  if (!s?._sock) throw new Error("Session not connected yet (waiting for QR)");
  const cleanPhone = phone.replace(/\D/g, "");
  if (cleanPhone.length < 10) throw new Error("Invalid phone number");
  const code = await s._sock.requestPairingCode(cleanPhone);
  s.pairingCode = code;
  addLog(s, `Pairing code for +${cleanPhone}: ${code}`);
  return code;
}

// ── Custom commands ──────────────────────────────────────────────────────
let customCommands: Record<string, string> = {};
try {
  customCommands = JSON.parse(fs.readFileSync(CUSTOM_COMMANDS_FILE, "utf-8"));
  console.log(`📂 Loaded ${Object.keys(customCommands).length} custom commands`);
} catch { /* ignore */ }

// ── View‑once cache ──────────────────────────────────────────────────────
const CACHE_FILE = path.join(BASE_DIR, "vo-cache.json");
type CacheEntry = {
  chatJid: string;
  senderJid: string;
  mediaType: "image" | "video" | "audio";
  mediaMsg: { url?: string; directPath?: string; mediaKey?: unknown; mimetype?: string };
  savedAt: number;
};
function loadCache(): Record<string, CacheEntry> {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { return {}; }
}
function saveCache(map: Record<string, CacheEntry>) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(map)); } catch { /* ignore */ }
}

// ── Helpers ──────────────────────────────────────────────────────────────
function getOwnerJid(sock: WASocket): string | null {
  const raw = sock.user?.id ?? (sock.user as any)?.lid;
  if (!raw) return null;
  try {
    const n = jidNormalizedUser(raw);
    if (n?.includes("@")) return n;
  } catch { }
  const num = raw.split(":")[0]?.split("@")[0];
  if (num && /^\d+$/.test(num)) return `${num}@s.whatsapp.net`;
  return null;
}

function isFromMe(msg: WAMessage, sock: WASocket): boolean {
  const ownerJid = getOwnerJid(sock);
  if (!ownerJid) return false;
  const sender = msg.key.participant ?? msg.key.remoteJid ?? "";
  return sender === ownerJid || msg.key.fromMe === true;
}

function getText(msg: WAMessage): string {
  const m = msg.message;
  if (!m) return "";
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  return "";
}

function mimeToExt(mime?: string | null): string {
  if (!mime) return "bin";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("mp4") || mime.includes("video")) return "mp4";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("ogg") || mime.includes("opus")) return "ogg";
  return "bin";
}

type MediaMsg = { url?: string; directPath?: string; mediaKey?: unknown; mimetype?: string };

function extractViewOnceMedia(message: any): {
  mediaMsg: MediaMsg; mediaType: "image" | "video" | "audio";
} | null {
  if (!message) return null;
  const inner =
    message?.viewOnceMessage?.message ??
    message?.viewOnceMessageV2?.message ??
    message?.viewOnceMessageV2Extension?.message;
  if (inner) {
    const img = inner.imageMessage;
    const vid = inner.videoMessage;
    const aud = inner.audioMessage;
    if (img) return { mediaMsg: img, mediaType: "image" };
    if (vid) return { mediaMsg: vid, mediaType: "video" };
    if (aud) return { mediaMsg: aud, mediaType: "audio" };
  }
  const img = message.imageMessage;
  const vid = message.videoMessage;
  if (img?.viewOnce === true) return { mediaMsg: img, mediaType: "image" };
  if (vid?.viewOnce === true) return { mediaMsg: vid, mediaType: "video" };
  if (message.extendedTextMessage?.contextInfo?.quotedMessage) {
    return extractViewOnceMedia(message.extendedTextMessage.contextInfo.quotedMessage);
  }
  return null;
}

function extractViewOnceFromQuoted(q: Record<string, unknown>): {
  mediaMsg: MediaMsg; mediaType: "image" | "video";
} | null {
  for (const key of ["viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension"]) {
    const w = (q[key] as { message?: Record<string, unknown> } | undefined)?.message;
    if (w) {
      const img = w["imageMessage"] as MediaMsg | undefined;
      const vid = w["videoMessage"] as MediaMsg | undefined;
      if (img) return { mediaMsg: img, mediaType: "image" };
      if (vid) return { mediaMsg: vid, mediaType: "video" };
    }
  }
  const img = q["imageMessage"] as MediaMsg | undefined;
  const vid = q["videoMessage"] as MediaMsg | undefined;
  if (img) return { mediaMsg: img, mediaType: "image" };
  if (vid) return { mediaMsg: vid, mediaType: "video" };
  return null;
}

// ── Media download ─────────────────────────────────────────────────────
async function downloadMedia(
  mediaMsg: MediaMsg,
  mediaType: "image" | "video" | "audio",
): Promise<Buffer> {
  const stream = await downloadContentFromMessage(
    mediaMsg as Parameters<typeof downloadContentFromMessage>[0],
    mediaType,
  );
  return toBuffer(stream);
}

// ── Send to owner DM ──────────────────────────────────────────────────────
async function sendToOwnerDM(
  sock: WASocket,
  ownerJid: string,
  buffer: Buffer,
  mediaType: "image" | "video" | "audio",
  mime: string | undefined,
  caption: string,
  addLogFn: (s: string) => void,
): Promise<boolean> {
  try {
    if (mediaType === "image") await sock.sendMessage(ownerJid, { image: buffer, caption });
    else if (mediaType === "video") await sock.sendMessage(ownerJid, { video: buffer, caption });
    else await sock.sendMessage(ownerJid, { audio: buffer, mimetype: mime ?? "audio/ogg; codecs=opus", ptt: true });
    addLogFn(`✅ Sent to owner DM`);
    return true;
  } catch (e) {
    addLogFn(`❌ DM send failed: ${(e as Error).message}`);
    return false;
  }
}

// ── Feature: Auto‑capture view‑once ────────────────────────────────────
async function handleViewOnce(
  sock: WASocket,
  msg: WAMessage,
  chatJid: string,
  addSavedFile: (f: string) => void,
  addLogFn: (s: string) => void,
): Promise<void> {
  const extracted = extractViewOnceMedia(msg.message);
  if (!extracted) return;

  const ownerJid = getOwnerJid(sock);
  if (!ownerJid) return;

  const isGroup = chatJid.endsWith("@g.us");
  const senderJid = isGroup ? (msg.key.participant ?? chatJid) : chatJid;
  const fromLabel = senderJid.split("@")[0] ?? "unknown";
  const inLabel = isGroup ? ` in group ${chatJid.split("@")[0]}` : "";

  const msgId = msg.key.id;
  if (msgId) {
    const cache = loadCache();
    if (!cache[msgId]) {
      cache[msgId] = {
        chatJid,
        senderJid,
        mediaType: extracted.mediaType,
        mediaMsg: extracted.mediaMsg,
        savedAt: Date.now(),
      };
      saveCache(cache);
    }
    addLogFn(`📦 Cached view-once ID: ${msgId}`);
  }

  addLogFn(`📥 View-once ${extracted.mediaType} from +${fromLabel}${inLabel} — capturing…`);
  try {
    const buffer = await downloadMedia(extracted.mediaMsg, extracted.mediaType);
    const ext = mimeToExt(extracted.mediaMsg.mimetype);
    const mime = extracted.mediaMsg.mimetype ?? "application/octet-stream";
    const filename = `vo_${Date.now()}_${fromLabel}.${ext}`;
    fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
    addSavedFile(filename);
    addLogFn(`💾 Saved to ${filename}`);
    const caption = `🔓 *View-once ${extracted.mediaType}* (auto-saved)\nFrom: +${fromLabel}${inLabel}`;
    await sendToOwnerDM(sock, ownerJid, buffer, extracted.mediaType, mime, caption, addLogFn);
  } catch (e) {
    addLogFn(`⚠️ Auto-capture failed: ${(e as Error).message}`);
  }
}

// ── Feature: Reaction trigger ──────────────────────────────────────────
async function handleReaction(
  sock: WASocket,
  msg: WAMessage,
  addSavedFile: (f: string) => void,
  addLogFn: (s: string) => void,
): Promise<void> {
  const reaction = msg.message?.reactionMessage;
  if (!reaction) return;

  const emoji = reaction.text ?? "";
  const TRIGGER_EMOJIS = new Set(["🙂", "😣", "🤪", "😇", "🥺"]);
  if (!TRIGGER_EMOJIS.has(emoji)) return;

  if (!isFromMe(msg, sock)) return;

  const originalId = reaction.key?.id ?? "";
  addLogFn(`🔁 Owner reacted ${emoji} on msg ${originalId}`);

  // Try cache (loadMessages fallback not available in this Baileys version)
  const cache = loadCache();
  const entry = cache[originalId];

  if (!entry) {
    addLogFn(`❌ Not found in cache for ${originalId}`);
    return;
  }

  const fromLabel = entry.senderJid.split("@")[0] ?? "unknown";
  const inLabel = entry.chatJid.endsWith("@g.us") ? ` in group ${entry.chatJid.split("@")[0]}` : "";
  const caption = `🔓 *View-once ${entry.mediaType}* (saved via ${emoji})\nFrom: +${fromLabel}${inLabel}`;

  addLogFn(`📥 Reaction trigger: downloading ${entry.mediaType}…`);
  try {
    const buffer = await downloadMedia(entry.mediaMsg as MediaMsg, entry.mediaType);
    const ext = mimeToExt(entry.mediaMsg.mimetype);
    const mime = entry.mediaMsg.mimetype ?? "application/octet-stream";
    const filename = `vo_react_${Date.now()}_${fromLabel}.${ext}`;
    fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
    addSavedFile(filename);
    addLogFn(`💾 Saved reaction file: ${filename}`);
    const ownerJid = getOwnerJid(sock);
    if (ownerJid) {
      await sendToOwnerDM(sock, ownerJid, buffer, entry.mediaType, mime, caption, addLogFn);
      addLogFn(`✅ Reaction save complete`);
    }
  } catch (e) {
    addLogFn(`❌ Reaction download failed: ${(e as Error).message}`);
  }
}

// ── Feature: Auto‑like statuses ────────────────────────────────────────
async function handleStatusReaction(sock: WASocket, msg: WAMessage): Promise<void> {
  const chatJid = msg.key.remoteJid || "";
  if (chatJid !== "status@broadcast" && !chatJid.endsWith("@broadcast")) return;
  if (isFromMe(msg, sock)) return;

  const REACTIONS = ["❤️", "🔥", "🥰", "😍", "💯", "😘", "👏", "🙌", "🤗", "✨", "💖", "🌟"];
  const emoji = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
  try {
    await sock.sendMessage(chatJid, {
      react: { text: emoji, key: msg.key },
    });
    console.log(`✅ Liked status with ${emoji}`);
  } catch (e) {
    console.error(`❌ Status like failed:`, e);
  }
}

// ── Feature: .save (status media) ──────────────────────────────────────
async function handleSaveStatus(
  sock: WASocket,
  msg: WAMessage,
  chatJid: string,
  addSavedFile: (f: string) => void,
  addLogFn: (s: string) => void,
): Promise<boolean> {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return false;
  if (ctx.remoteJid !== "status@broadcast") {
    await sock.sendMessage(chatJid, { text: `Reply to a status with *${CMD}save* to save it.` });
    return true;
  }

  const quoted = ctx.quotedMessage as Record<string, any>;
  const media = (quoted.imageMessage || quoted.videoMessage || quoted.audioMessage) as MediaMsg | undefined;
  if (!media) return false;

  try {
    const type: "image" | "video" | "audio" = quoted.imageMessage ? "image" : quoted.videoMessage ? "video" : "audio";
    const buffer = await downloadMedia(media, type);
    const ext = mimeToExt(media.mimetype);
    const filename = `status_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
    addSavedFile(filename);
    addLogFn(`💾 Saved status: ${filename}`);
    await sock.sendMessage(chatJid, { text: `✅ Status saved as ${filename}` });
    return true;
  } catch (e) {
    addLogFn(`❌ Save status failed: ${(e as Error).message}`);
    return false;
  }
}

// ── Feature: .sticker ──────────────────────────────────────────────────
async function handleSticker(
  sock: WASocket,
  msg: WAMessage,
  chatJid: string,
  addLogFn: (s: string) => void,
): Promise<boolean> {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return false;

  const quoted = ctx.quotedMessage as Record<string, any>;
  const media = (quoted.imageMessage || quoted.videoMessage) as MediaMsg | undefined;
  if (!media) return false;

  try {
    const type: "image" | "video" = quoted.imageMessage ? "image" : "video";
    const buffer = await downloadMedia(media, type);

    let stickerBuffer: Buffer;
    if (type === "image") {
      stickerBuffer = await sharp(buffer).webp().toBuffer();
    } else {
      addLogFn(`⚠️ Video sticker requires ffmpeg – sending as document.`);
      await sock.sendMessage(chatJid, { document: buffer, mimetype: "video/mp4", fileName: "sticker.mp4" });
      return true;
    }

    await sock.sendMessage(chatJid, { sticker: stickerBuffer });
    addLogFn(`✅ Sticker sent`);
    return true;
  } catch (e) {
    addLogFn(`❌ Sticker failed: ${(e as Error).message}`);
    return false;
  }
}

// ── Feature: .savepp ──────────────────────────────────────────────────
async function handleSavePP(
  sock: WASocket,
  msg: WAMessage,
  chatJid: string,
  addSavedFile: (f: string) => void,
  addLogFn: (s: string) => void,
): Promise<boolean> {
  const sender = msg.key.participant ?? msg.key.remoteJid ?? chatJid;
  try {
    const pp = await sock.profilePictureUrl(sender, "image");
    if (!pp) {
      addLogFn(`❌ No profile picture available`);
      return false;
    }
    const resp = await fetch(pp);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const filename = `pp_${sender.split("@")[0]}.jpg`;
    fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
    addSavedFile(filename);
    addLogFn(`💾 Saved profile picture: ${filename}`);
    await sock.sendMessage(chatJid, { text: `✅ Profile picture saved as ${filename}` });
    return true;
  } catch (e) {
    addLogFn(`❌ Save PP failed: ${(e as Error).message}`);
    return false;
  }
}

// ── Feature: .vv ──────────────────────────────────────────────────────
async function handleVv(
  sock: WASocket,
  msg: WAMessage,
  chatJid: string,
  addSavedFile: (f: string) => void,
  addLogFn: (s: string) => void,
): Promise<boolean> {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return false;

  const quoted = ctx.quotedMessage as Record<string, unknown>;
  const extracted = extractViewOnceFromQuoted(quoted);
  if (!extracted) return false;

  const ownerJid = getOwnerJid(sock);
  if (!ownerJid) return false;

  try {
    const buffer = await downloadMedia(extracted.mediaMsg, extracted.mediaType);
    const ext = mimeToExt(extracted.mediaMsg.mimetype);
    const filename = `vv_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
    addSavedFile(filename);
    addLogFn(`💾 Saved via .vv: ${filename}`);
    const caption = `🔓 *View-once ${extracted.mediaType} (.vv)*\nFrom: +${chatJid.split("@")[0]}`;
    await sendToOwnerDM(sock, ownerJid, buffer, extracted.mediaType, extracted.mediaMsg.mimetype, caption, addLogFn);
    return true;
  } catch (e) {
    addLogFn(`❌ .vv failed: ${(e as Error).message}`);
    return false;
  }
}

// ── SESSION ──────────────────────────────────────────────────────────────────
export async function startSession(id: string, label?: string) {
  let state = sessions.get(id);
  if (!state) {
    state = {
      id,
      label: label || id,
      status: "disconnected",
      qrDataUrl: null,
      pairingCode: null,
      phoneNumber: null,
      _sock: null,
      _stopRequested: false,
      _retryCount: 0,
      savedFiles: [],
      log: [],
    };
    sessions.set(id, state);
  }

  const authDir = path.join(BASE_DIR, "sessions", id, "auth");
  fs.mkdirSync(authDir, { recursive: true });

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    addLog(state, `Starting (Baileys ${version.join(".")})`);
    state.status = "connecting";

    const logger = pino({ level: "silent" });
    const sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, logger),
      },
      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false,
      syncFullHistory: false,
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 10_000,
      retryRequestDelayMs: 250,
      maxMsgRetryCount: 5,
      defaultQueryTimeoutMs: 0,
      logger,
      getMessage: async () => ({ conversation: "" }),
    });

    state._sock = sock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try {
          const { default: QRCode } = await import("qrcode");
          state.qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
        } catch { }
        state.status = "qr";
        addLog(state, "QR code ready");
      }
      if (connection === "open") {
        state.status = "connected";
        state.qrDataUrl = null;
        state.phoneNumber = sock.user?.id?.split(":")[0] || null;
        addLog(state, `✅ Connected as +${state.phoneNumber}`);
      }
      if (connection === "close") {
        const err = lastDisconnect?.error as Boom | undefined;
        const code = err?.output?.statusCode ?? 0;
        state.status = "disconnected";
        state._sock = null;
        if (code === DisconnectReason.loggedOut) {
          addLog(state, "Logged out – clearing auth");
          fs.rmSync(authDir, { recursive: true, force: true });
          fs.mkdirSync(authDir, { recursive: true });
          if (!state._stopRequested) setTimeout(() => startSession(id), 1500);
        } else if (!state._stopRequested) {
          state._retryCount = Math.min(state._retryCount + 1, 5);
          const delay = 2000 * state._retryCount;
          addLog(state, `Reconnecting in ${delay}ms`);
          setTimeout(() => startSession(id), delay);
        }
      }
    });

    // ── Auto‑reconnect monitor ──────────────────────────────────────────
    setInterval(async () => {
      try {
        const st = sessions.get(id);
        if (!st || st.status !== "connected") return;
        const s = st._sock;
        if (!s) return;
        if (!s.user) {
          addLog(st, "⚠️ Socket user missing – restarting session");
          st._sock = null;
          st.status = "disconnected";
          await startSession(id);
          return;
        }
        await s.sendPresenceUpdate("available");
      } catch (err) {
        const st = sessions.get(id);
        if (!st) return;
        addLog(st, `⚠️ Health check failed: ${(err as Error).message} – restarting`);
        st._sock = null;
        st.status = "disconnected";
        await startSession(id);
      }
    }, 60_000);

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      console.log(`🔥 MESSAGES.UPSERT type=${type}, count=${messages.length}`);

      for (const msg of messages) {
        if (!msg.message) continue;

        const chatJid = msg.key.remoteJid || "";
        const isStatus = chatJid === "status@broadcast" || chatJid.endsWith("@broadcast");
        const text = getText(msg);

        // ── Reaction trigger ──────────────────────────────────────────────
        if (msg.message?.reactionMessage) {
          await handleReaction(sock, msg, (f) => {
            state.savedFiles.unshift(f);
            if (state.savedFiles.length > 30) state.savedFiles.pop();
          }, (m) => addLog(state, m));
        }

        // ── Status handling ──────────────────────────────────────────────
        if (isStatus) {
          await handleStatusReaction(sock, msg);
          continue;
        }

        // ── Auto‑capture view‑once ──────────────────────────────────────
        await handleViewOnce(sock, msg, chatJid, (f) => {
          state.savedFiles.unshift(f);
          if (state.savedFiles.length > 30) state.savedFiles.pop();
        }, (m) => addLog(state, m));

        // ── Auto‑presence ───────────────────────────────────────────────
        if (text) {
          sock.readMessages([msg.key]).catch(() => { });
          const lowerPresence = text.trim().toLowerCase();
          if (lowerPresence.startsWith("sticker") || lowerPresence === ".sticker") {
            showRecording(sock, chatJid, 2000).catch(() => { });
          } else {
            startSustainedTyping(sock, chatJid, 60_000);
          }
        }

        // ── If no text, skip commands ──────────────────────────────────
        if (!text) continue;

        console.log(`📩 Received: "${text}" from ${chatJid}`);

        // ── Custom commands ──────────────────────────────────────────────
        const lower = text.trim().toLowerCase();
        if (customCommands[lower]) {
          await sock.sendMessage(chatJid, { text: customCommands[lower] });
          console.log(`📝 Custom command: "${lower}" → "${customCommands[lower]}"`);
          continue;
        }

        // ── Commands (with or without .) ──────────────────────────────
        const cmd = lower.startsWith(".") ? lower.slice(1) : lower;

        if (cmd === "ping") {
          await sock.sendMessage(chatJid, { text: "🏓 Pong!" });
          console.log(`✅ Pong sent`);
          continue;
        }

        if (cmd === "menu" || cmd === "help") {
          await sock.sendMessage(chatJid, {
            text: `🤖 *Bot Commands*\n\n` +
              `*Basics*\n` +
              `• \`ping\` — check if alive\n` +
              `• \`menu\` — show this menu\n\n` +
              `*Media*\n` +
              `• \`vv\` — reply to a view-once to save it\n` +
              `• \`sticker\` — reply to image/video → sticker\n` +
              `• \`save\` — reply to a status to save it\n` +
              `• \`savepp\` — save sender's profile picture\n\n` +
              `*Dashboard*\n` +
              `• Manage: ${process.env.PUBLIC_URL || 'http://localhost:8080'}/admin\n` +
              `• Link your number: ${process.env.PUBLIC_URL || 'http://localhost:8080'}/user`,
          });
          continue;
        }

        if (cmd === "save") {
          const ok = await handleSaveStatus(sock, msg, chatJid,
            (f) => { state.savedFiles.unshift(f); if (state.savedFiles.length > 30) state.savedFiles.pop(); },
            (m) => addLog(state, m)
          );
          if (ok) continue;
        }

        if (cmd === "sticker") {
          const ok = await handleSticker(sock, msg, chatJid, (m) => addLog(state, m));
          if (ok) continue;
        }

        if (cmd === "savepp") {
          const ok = await handleSavePP(sock, msg, chatJid,
            (f) => { state.savedFiles.unshift(f); if (state.savedFiles.length > 30) state.savedFiles.pop(); },
            (m) => addLog(state, m)
          );
          if (ok) continue;
        }

        if (cmd === "vv") {
          const ok = await handleVv(sock, msg, chatJid,
            (f) => { state.savedFiles.unshift(f); if (state.savedFiles.length > 30) state.savedFiles.pop(); },
            (m) => addLog(state, m)
          );
          if (ok) continue;
        }
      }
    });

  } catch (err) {
    addLog(state, `Init error: ${(err as Error).message}`);
    if (!state._stopRequested) {
      state._retryCount++;
      const delay = Math.min(5000 * state._retryCount, 30000);
      setTimeout(() => startSession(id), delay);
    }
  }
}

export async function startBot() {
  // Restore all previously linked sessions
  const list = loadSessionIds();
  if (list.length === 0) {
    console.log(`ℹ️ No saved sessions to restore. Create one via /admin`);
    return;
  }

  console.log(`🔄 Restoring ${list.length} session(s)...`);
  for (const { id, label } of list) {
    try {
      await startSession(id, label);
      // Small delay between sessions to avoid rate limits
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`Failed to restore session ${id}:`, e);
    }
  }
}