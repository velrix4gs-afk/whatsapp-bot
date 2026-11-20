/**
 * WhatsApp Bot – All‑in‑One
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
import { createClient } from "@supabase/supabase-js";
import { startSustainedTyping, showRecording } from "./features/presence";
import sharp from "sharp";
import { currentSettings, applySettings, type AiProviderConfig } from "./settings";

// ── Constants ──────────────────────────────────────────────────────────────
const BASE_DIR = path.join(process.cwd(), "data");
const MEDIA_DIR = path.join(BASE_DIR, "saved_media");
const CUSTOM_COMMANDS_FILE = path.join(BASE_DIR, "custom_commands.json");
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

// ── In‑memory view‑once cache for groups (for .vv command) ────────────────
const voCache = new Map<string, {
  mediaMsg: { url?: string; directPath?: string; mediaKey?: unknown; mimetype?: string };
  mediaType: "image" | "video";
  senderJid: string;
  chatJid: string;
}>();

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

// ── Session registry ────────────────────────────────────────────────────────
const sessions = new Map<string, any>();

function addLog(state: any, msg: string) {
  console.log(`[WA]`, msg);
}

// ── Exports for dashboard & API ────────────────────────────────────────────
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
    pairingCode: s.pairingCode,
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
  if (!s) throw new Error("Session not found");
  if (s.pairingCode) return s.pairingCode;
  if (!s._sock) throw new Error("Session not ready yet — try again in 5 seconds");
  const cleanPhone = phone.replace(/\D/g, "");
  if (cleanPhone.length < 10) throw new Error("Invalid phone number");
  const code = await s._sock.requestPairingCode(cleanPhone);
  s.pairingCode = code;
  addLog(s, `Pairing code for +${cleanPhone}: ${code}`);
  return code;
}

// ── Custom commands ────────────────────────────────────────────────────────
let customCommands: Record<string, string> = {};
try {
  customCommands = JSON.parse(fs.readFileSync(CUSTOM_COMMANDS_FILE, "utf-8"));
  console.log(`📂 Loaded ${Object.keys(customCommands).length} custom commands`);
} catch { /* ignore */ }

// ── Helpers ────────────────────────────────────────────────────────────────
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

function getAdminNumber(sock: WASocket): string | null {
  const adminNum = currentSettings?.adminNumber?.replace(/\D/g, "");
  if (!adminNum) return null;
  // Try to normalize to a valid JID
  try {
    return jidNormalizedUser(`${adminNum}@s.whatsapp.net`);
  } catch {
    return `${adminNum}@s.whatsapp.net`;
  }
}

function isFromMe(msg: WAMessage, sock: WASocket): boolean {
  const ownerJid = getOwnerJid(sock);
  if (!ownerJid) return false;
  const sender = msg.key.participant ?? msg.key.remoteJid ?? "";
  return sender === ownerJid || msg.key.fromMe === true;
}

function isAdmin(msg: WAMessage, sock: WASocket): boolean {
  const adminJid = getAdminNumber(sock);
  if (!adminJid) return false;
  const sender = msg.key.participant ?? msg.key.remoteJid ?? "";
  return sender === adminJid || msg.key.fromMe === true;
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

// ── Media download ────────────────────────────────────────────────────────
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

// ── Save to Supabase ──────────────────────────────────────────────────────
async function saveToSupabase(buffer: Buffer, filename: string, mime: string, phoneNumber?: string): Promise<boolean> {
  try {
    // Store under the user's phone number folder for proper organization
    const phone = phoneNumber || "default";
    const storagePath = `${phone}/${filename}`;
    const { error } = await supabase.storage
      .from("saved_media")
      .upload(storagePath, buffer, { contentType: mime, upsert: false });
    return !error;
  } catch {
    return false;
  }
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

// ── Feature: Auto‑like statuses (uses emoji pool from settings) ──────────
async function handleStatusReaction(sock: WASocket, msg: WAMessage): Promise<void> {
  const chatJid = msg.key.remoteJid || "";
  if (chatJid !== "status@broadcast" && !chatJid.endsWith("@broadcast")) return;
  if (isFromMe(msg, sock)) return;

  const pool = currentSettings.reactionEmojis;
  if (!pool.length) return;
  const emoji = pool[Math.floor(Math.random() * pool.length)];
  try {
    await sock.sendMessage(chatJid, {
      react: { text: emoji, key: msg.key },
    });
    console.log(`✅ Liked status with ${emoji}`);
  } catch (e) {
    console.error(`❌ Status like failed:`, e);
  }
}

// ── AI Rule Matching ────────────────────────────────────────────────────────
function matchRule(rule: { trigger: string; matchType: "exact" | "contains" | "startsWith" | "endsWith" | "regex" }, text: string): boolean {
  const t = text.toLowerCase();
  const trig = rule.trigger.toLowerCase();
  switch (rule.matchType) {
    case "exact": return t === trig;
    case "contains": return t.includes(trig);
    case "startsWith": return t.startsWith(trig);
    case "endsWith": return t.endsWith(trig);
    case "regex": return new RegExp(trig, "i").test(t);
    default: return false;
  }
}

// ── AI Reply Handler ─────────────────────────────────────────────────────────
async function handleAiReply(
  sock: WASocket,
  msg: WAMessage,
  chatJid: string,
  senderJid: string,
  provider: AiProviderConfig,
  addLogFn: (s: string) => void
): Promise<void> {
  const messageText = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? "";
  if (!messageText.trim()) return;

  try {
    addLogFn(`🤖 AI thinking for ${senderJid}...`);

    const response = await callAiProvider(provider, messageText);
    if (response) {
      await sock.sendMessage(senderJid, { text: response }, { quoted: msg });
      addLogFn(`🤖 AI replied to ${senderJid}`);
    }
  } catch (err) {
    const errMsg = (err as Error).message;
    addLogFn(`AI error: ${errMsg}`);
    await sock.sendMessage(senderJid, { text: `❌ AI error: ${errMsg.slice(0, 150)}` }, { quoted: msg });
  }
}

async function callAiProvider(
  provider: AiProviderConfig,
  text: string
): Promise<string | null> {
  const systemPrompt = currentSettings.aiSystemPrompt || "You are a helpful WhatsApp assistant. Keep responses short and friendly.";

  if (provider.provider === "openai") {
    return callOpenAI(provider, text, systemPrompt);
  } else if (provider.provider === "anthropic") {
    return callAnthropic(provider, text, systemPrompt);
  } else if (provider.provider === "gemini") {
    return callGemini(provider, text, systemPrompt);
  } else if (provider.provider === "custom" && provider.baseUrl) {
    return callCustom(provider, text, systemPrompt);
  }
  return null;
}

async function callOpenAI(
  provider: AiProviderConfig,
  text: string,
  systemPrompt: string
): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      max_tokens: 500,
    }),
  });
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content || "(no response)";
}

async function callAnthropic(
  provider: AiProviderConfig,
  text: string,
  systemPrompt: string
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": provider.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model || "claude-3-5-haiku-20241022",
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: "user", content: text }],
    }),
  });
  const data = await res.json() as { content?: { type: string; text: string }[] };
  return data.content?.[0]?.text || "(no response)";
}

async function callGemini(
  provider: AiProviderConfig,
  inputText: string,
  systemPrompt: string
): Promise<string> {
  const baseUrl = provider.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const res = await fetch(`${baseUrl}/models/${provider.model || "gemini-2.5-flash"}:generateContent?key=${provider.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: inputText }], role: "user" }],
      generationConfig: { maxOutputTokens: 500 },
    }),
  });
  const data = await res.json() as any;
  const response = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return response || "(no response)";
}

async function callCustom(
  provider: AiProviderConfig,
  text: string,
  systemPrompt: string
): Promise<string> {
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      max_tokens: 500,
    }),
  });
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content || "(no response)";
}

// ── Feature: View‑once — auto‑save DMs, cache groups for .vv ─────────────
async function handleViewOnce(
  sock: WASocket,
  msg: WAMessage,
  chatJid: string,
  addSavedFile: (f: string) => void,
  addLogFn: (s: string) => void,
): Promise<void> {
  const extracted = extractViewOnceMedia(msg.message);
  if (!extracted) return;

  const isGroup = chatJid.endsWith("@g.us");

  // Cache the media descriptor for groups — saved when .vv is used
  if (isGroup) {
    const msgId = msg.key.id;
    if (msgId) {
      const senderJid = msg.key.participant ?? chatJid;
      voCache.set(msgId, {
        mediaMsg: extracted.mediaMsg,
        mediaType: extracted.mediaType as "image" | "video",
        senderJid,
        chatJid,
      });
      addLogFn(`📦 View-once cached for .vv (group)`);
    }
    return;
  }

  // DMs: auto‑download and forward to owner DM immediately
  const ownerJid = getOwnerJid(sock);
  if (!ownerJid) return;

  const fromLabel = chatJid.split("@")[0] ?? "unknown";
  addLogFn(`📥 View-once ${extracted.mediaType} from +${fromLabel} — auto-saving…`);
  try {
    const buffer = await downloadMedia(extracted.mediaMsg, extracted.mediaType);
    const ext = mimeToExt(extracted.mediaMsg.mimetype);
    const mime = extracted.mediaMsg.mimetype ?? "application/octet-stream";
    const filename = `vo_${Date.now()}_${fromLabel}.${ext}`;

    const success = await saveToSupabase(buffer, filename, mime);
    addSavedFile(filename);
    addLogFn(`💾 Saved view-once ${success ? "to Supabase" : "to Supabase failed"}`);

    const caption = `🔓 *View-once ${extracted.mediaType}* (auto-saved)\nFrom: +${fromLabel}`;
    await sendToOwnerDM(sock, ownerJid, buffer, extracted.mediaType, mime, caption, addLogFn);
  } catch (e) {
    addLogFn(`⚠️ Auto-capture failed: ${(e as Error).message}`);
  }
}

// ── Feature: Reaction trigger (owner reacts 🙂/😣/🤪/😇/🥺) ──────────────
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

  const entry = voCache.get(originalId);
  if (!entry) {
    addLogFn(`❌ Not found in cache for ${originalId}`);
    return;
  }

  const fromLabel = entry.senderJid.split("@")[0] ?? "unknown";
  const caption = `🔓 *View-once ${entry.mediaType}* (saved via ${emoji})\nFrom: +${fromLabel}`;

  addLogFn(`📥 Reaction trigger: downloading ${entry.mediaType}…`);
  try {
    const buffer = await downloadMedia(entry.mediaMsg, entry.mediaType);
    const ext = mimeToExt(entry.mediaMsg.mimetype);
    const mime = entry.mediaMsg.mimetype ?? "application/octet-stream";
    const filename = `vo_react_${Date.now()}_${fromLabel}.${ext}`;

    await saveToSupabase(buffer, filename, mime);
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

// ── Feature: .save (status media) — silent: deletes cmd, saves to DM only ──
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

  const ownerJid = getOwnerJid(sock);
  if (!ownerJid) return false;

  try {
    const type: "image" | "video" | "audio" =
      quoted.imageMessage ? "image" : quoted.videoMessage ? "video" : "audio";
    const buffer = await downloadMedia(media, type);
    const ext = mimeToExt(media.mimetype);
    const filename = `status_${Date.now()}.${ext}`;

    await saveToSupabase(buffer, filename, media.mimetype ?? "application/octet-stream");
    addSavedFile(filename);
    addLogFn(`💾 Saved status: ${filename}`);

    // Silent: only send to owner DM, no chat reply
    const caption = `🔓 *Status ${type}* (saved)\nFrom: +${(ctx.participant ?? "").split("@")[0] || "unknown"}`;
    await sendToOwnerDM(sock, ownerJid, buffer, type, media.mimetype, caption, addLogFn);
    return true;
  } catch (e) {
    addLogFn(`❌ Save status failed: ${(e as Error).message}`);
    return false;
  }
}

// ── Feature: .sticker ────────────────────────────────────────────────────
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

// ── Feature: .savepp ────────────────────────────────────────────────────
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

    await saveToSupabase(buffer, filename, "image/jpeg");
    addSavedFile(filename);
    addLogFn(`💾 Saved profile picture: ${filename}`);
    await sock.sendMessage(chatJid, { text: `✅ Profile picture saved` });
    return true;
  } catch (e) {
    addLogFn(`❌ Save PP failed: ${(e as Error).message}`);
    return false;
  }
}

// ── Feature: .vv — saves cached group view-once to Supabase + DM ─────────
async function handleVv(
  sock: WASocket,
  msg: WAMessage,
  chatJid: string,
  addSavedFile: (f: string) => void,
  addLogFn: (s: string) => void,
): Promise<boolean> {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return false;

  // Get the quoted message ID
  const quotedId = (ctx.quotedMessage as any)?.key?.id
    ?? (ctx.quotedMessage as Record<string, unknown>)["id"] as string
    ?? "";

  // Try cache first (works for group view-once messages)
  const cached = quotedId ? voCache.get(quotedId) : undefined;

  let mediaMsg: MediaMsg | null = null;
  let mediaType: "image" | "video" | null = null;
  let senderJid = chatJid;

  if (cached) {
    mediaMsg = cached.mediaMsg;
    mediaType = cached.mediaType;
    senderJid = cached.senderJid;
    voCache.delete(quotedId); // one‑shot
  } else {
    // Fallback: extract directly from quoted message (DMs, or any view-once)
    const quoted = ctx.quotedMessage as Record<string, unknown>;
    for (const key of ["viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension"]) {
      const w = (quoted[key] as { message?: Record<string, unknown> } | undefined)?.message;
      if (w) {
        if (w["imageMessage"]) { mediaMsg = w["imageMessage"] as MediaMsg; mediaType = "image"; break; }
        if (w["videoMessage"])  { mediaMsg = w["videoMessage"] as MediaMsg; mediaType = "video"; break; }
      }
    }
    if (!mediaMsg) {
      if (quoted["imageMessage"]) { mediaMsg = quoted["imageMessage"] as MediaMsg; mediaType = "image"; }
      else if (quoted["videoMessage"]) { mediaMsg = quoted["videoMessage"] as MediaMsg; mediaType = "video"; }
    }
  }

  if (!mediaMsg || !mediaType) {
    addLogFn(`❌ .vv: no view-once media found in quoted message`);
    return false;
  }

  const ownerJid = getOwnerJid(sock);
  if (!ownerJid) return false;

  try {
    addLogFn(`📥 .vv: downloading ${mediaType}…`);
    const buffer = await downloadMedia(mediaMsg, mediaType);
    const ext = mimeToExt(mediaMsg.mimetype);
    const filename = `vv_${Date.now()}.${ext}`;

    const success = await saveToSupabase(buffer, filename, mediaMsg.mimetype ?? "application/octet-stream");
    addSavedFile(filename);
    addLogFn(`💾 Saved via .vv: ${filename}${success ? "" : " (Supabase failed)"}`);

    const fromLabel = senderJid.split("@")[0] ?? "unknown";
    const caption = `🔓 *View-once ${mediaType}* (.vv)\nFrom: +${fromLabel}`;
    await sendToOwnerDM(sock, ownerJid, buffer, mediaType, mediaMsg.mimetype, caption, addLogFn);
    return true;
  } catch (e) {
    addLogFn(`❌ .vv failed: ${(e as Error).message}`);
    return false;
  }
}

// ── SESSION ─────────────────────────────────────────────────────────────────
export async function startSession(id: string, label?: string, pairingPhone?: string) {
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
      _starting: false,
      _pairingRequested: false,
      savedFiles: [],
      log: [],
    };
    sessions.set(id, state);
  }
  if (state._starting || state.status === "connected" || state.status === "connecting") {
    addLog(state, `⏭️ Already ${state.status} — skipping duplicate start`);
    return;
  }
  state._starting = true;

  if (state._sock) {
    try {
      state._sock.ev.removeAllListeners("messages.upsert");
      state._sock.ev.removeAllListeners("connection.update");
      state._sock.ev.removeAllListeners("creds.update");
      state._sock.end(undefined);
    } catch { }
    state._sock = null;
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
      browser: Browsers.ubuntu(`NovaBot-${id}`),
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
        if (pairingPhone) {
          addLog(state, "⏭️ QR received but in pairing mode — ignoring");
        } else {
          try {
            const { default: QRCode } = await import("qrcode");
            state.qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
          } catch { }
          state.status = "qr";
          addLog(state, "QR code ready");
        }
        if (pairingPhone && !state._pairingRequested && !authState.creds.registered) {
          state._pairingRequested = true;
          try {
            const cleanPhone = pairingPhone.replace(/\D/g, "");
            const code = await sock.requestPairingCode(cleanPhone);
            state.pairingCode = code;
            addLog(state, `🔢 Pairing code for +${cleanPhone}: ${code}`);
          } catch (e) {
            addLog(state, `❌ Pairing failed: ${(e as Error).message}`);
            state._pairingRequested = false;
          }
        }
      }
      if (connection === "open") {
        state.status = "connected";
        state.qrDataUrl = null;
        state.phoneNumber = sock.user?.id?.split(":")[0] || null;
        state._starting = false;
        state._pairingRequested = false;
        addLog(state, `✅ Connected as +${state.phoneNumber}`);
      }
      if (connection === "close") {
        const err = lastDisconnect?.error as Boom | undefined;
        const code = err?.output?.statusCode ?? 0;

        if (state.pairingCode && !authState.creds.registered) {
          addLog(state, "⏸️ Socket closed during pairing — NOT reconnecting");
          state.status = "disconnected";
          state._sock = null;
          state._starting = false;
          return;
        }

        state.status = "disconnected";
        state._sock = null;
        state._starting = false;
        state._pairingRequested = false;

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

    // ── Auto‑reconnect / presence monitor ─────────────────────────────
    setInterval(async () => {
      try {
        const st = sessions.get(id);
        if (!st || st.status !== "connected" || st._starting) return;
        if (st.pairingCode) return;
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
        if (!st || st._starting) return;
        if (st.pairingCode) return;
        addLog(st, `⚠️ Health check failed: ${(err as Error).message} – restarting`);
        st._sock = null;
        st.status = "disconnected";
        await startSession(id);
      }
    }, 60_000);

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      for (const msg of messages) {
        if (!msg.message) continue;

        const chatJid = msg.key.remoteJid || "";
        const isStatus = chatJid === "status@broadcast" || chatJid.endsWith("@broadcast");
        const text = getText(msg);

        // ── Reaction trigger ────────────────────────────────────────────
        if (msg.message?.reactionMessage) {
          await handleReaction(sock, msg,
            (f) => { state.savedFiles.unshift(f); if (state.savedFiles.length > 30) state.savedFiles.pop(); },
            (m) => addLog(state, m));
          continue;
        }

        // ── Status: auto‑like with random emoji ─────────────────────────
        if (isStatus) {
          await handleStatusReaction(sock, msg);
          continue;
        }

        // ── View‑once: auto‑save DMs, cache groups ─────────────────────
        await handleViewOnce(sock, msg, chatJid,
          (f) => { state.savedFiles.unshift(f); if (state.savedFiles.length > 30) state.savedFiles.pop(); },
          (m) => addLog(state, m));

        // ── Auto‑presence / typing ─────────────────────────────────────
        if (text && !isFromMe(msg, sock)) {
          sock.readMessages([msg.key]).catch(() => { });
          const lowerPresence = text.trim().toLowerCase();
          if (lowerPresence.startsWith("sticker") || lowerPresence === ".sticker") {
            showRecording(sock, chatJid, 2000).catch(() => { });
          } else {
            startSustainedTyping(sock, chatJid, 60_000);
          }
        }

        // ── If no text, skip commands ─────────────────────────────────
        if (!text) continue;

        const lower = text.trim().toLowerCase();

        // ── Custom commands ───────────────────────────────────────────
        if (customCommands[lower]) {
          await sock.sendMessage(chatJid, { text: customCommands[lower] });
          continue;
        }

        const cmd = lower.startsWith(".") ? lower.slice(1) : lower;
        const savedFileCb = (f: string) => {
          state.savedFiles.unshift(f);
          if (state.savedFiles.length > 30) state.savedFiles.pop();
        };
        const logCb = (m: string) => addLog(state, m);

        // ── .vv / vv — delete from chat first, then save ─────────────
        if (cmd === "vv") {
          try { await sock.sendMessage(chatJid, { delete: msg.key }); } catch { }
          const ok = await handleVv(sock, msg, chatJid, savedFileCb, logCb);
          if (ok) continue;
        }

        // ── .save — silent: delete from chat, save to DM only ─────────
        if (cmd === "save") {
          try { await sock.sendMessage(chatJid, { delete: msg.key }); } catch { }
          const ok = await handleSaveStatus(sock, msg, chatJid, savedFileCb, logCb);
          if (ok) continue;
        }

        // ── Other commands ────────────────────────────────────────────
        if (cmd === "ping") {
          await sock.sendMessage(chatJid, { text: "🏓 Pong!" });
          continue;
        }

        // ── Reply-mode gate ───────────────────────────────────────────
        // When replyMode === "only", only the admin (configured in settings) can trigger commands.
        // "menu", "help", "ping" are exempt (always allowed).
        const isAdminUser = isAdmin(msg, sock);
        const replyModeOnly = currentSettings?.features?.replyMode === "only";
        const allowedForAll = ["menu", "help", "ping"];
        if (replyModeOnly && !isAdminUser && !allowedForAll.includes(cmd)) {
          // Silently ignore — do not reply to avoid spam
          continue;
        }

        if (cmd === "menu" || cmd === "help") {
          const publicUrl = process.env.PUBLIC_URL || 'http://localhost:8080';
          await sock.sendMessage(chatJid, {
            text: `🤖 *NovaBot Commands*\n\n` +
              `*📋 Basics*\n` +
              `• \`ping\` — Check if alive\n` +
              `• \`menu\` — Show this menu\n` +
              `• \`help\` — Same as menu\n\n` +
              `*📸 Media*\n` +
              `• \`vv\` — Reply to a view-once to save it\n` +
              `• \`sticker\` — Reply to image/video → sticker\n` +
              `• \`save\` — Reply to a status to save it (silent)\n` +
              `• \`savepp\` — Save sender's profile picture\n\n` +
              `*⚙️ Features (owner only)*\n` +
              `• \`autoreact on/off\` — Auto-like statuses\n` +
              `• \`autotyping on/off\` — Show typing indicator\n` +
              `• \`antidelete on/off\` — Save deleted messages\n` +
              `• \`replymode only/all\` — Who can use commands\n\n` +
              `*🔗 Dashboard*\n` +
              `• Admin panel: ${publicUrl}/admin\n` +
              `• Link your number: ${publicUrl}/user\n` +
              `• View files: ${publicUrl}/my-files`,
          });
          continue;
        }

        if (cmd === "sticker") {
          const ok = await handleSticker(sock, msg, chatJid, logCb);
          if (ok) continue;
        }

        if (cmd === "savepp") {
          const ok = await handleSavePP(sock, msg, chatJid, savedFileCb, logCb);
          if (ok) continue;
        }

        // ── Feature toggles (admin only) ─────────────────────────────
        if (cmd.startsWith("autoreact")) {
          if (!isAdminUser) continue;
          const arg = cmd.split(/\s+/)[1]?.toLowerCase();
          if (arg === "on") {
            currentSettings.features.autoReact = true;
            applySettings(currentSettings);
            await sock.sendMessage(chatJid, { text: "✅ Auto-react enabled" });
          } else if (arg === "off") {
            currentSettings.features.autoReact = false;
            applySettings(currentSettings);
            await sock.sendMessage(chatJid, { text: "🚫 Auto-react disabled" });
          } else {
            await sock.sendMessage(chatJid, { text: `ℹ️ Auto-react is ${currentSettings.features.autoReact ? "on" : "off"}\nUsage: \`autoreact on\` or \`autoreact off\`` });
          }
          continue;
        }

        if (cmd.startsWith("autotyping")) {
          if (!isAdminUser) continue;
          const arg = cmd.split(/\s+/)[1]?.toLowerCase();
          if (arg === "on") {
            currentSettings.features.autoPresence = true;
            applySettings(currentSettings);
            await sock.sendMessage(chatJid, { text: "✅ Auto-typing enabled" });
          } else if (arg === "off") {
            currentSettings.features.autoPresence = false;
            applySettings(currentSettings);
            await sock.sendMessage(chatJid, { text: "🚫 Auto-typing disabled" });
          } else {
            await sock.sendMessage(chatJid, { text: `ℹ️ Auto-typing is ${currentSettings.features.autoPresence ? "on" : "off"}\nUsage: \`autotyping on\` or \`autotyping off\`` });
          }
          continue;
        }

        if (cmd.startsWith("replymode")) {
          if (!isAdminUser) continue;
          const arg = cmd.split(/\s+/)[1]?.toLowerCase();
          if (arg === "only" || arg === "all") {
            currentSettings.features.replyMode = arg;
            applySettings(currentSettings);
            await sock.sendMessage(chatJid, { text: `✅ Reply mode set to: *${arg}*` });
          } else {
            await sock.sendMessage(chatJid, { text: `ℹ️ Current reply mode: *${currentSettings.features.replyMode}*\nUsage: \`replymode only\` (admin only) or \`replymode all\` (everyone)` });
          }
          continue;
        }

        if (cmd.startsWith("antidelete")) {
          if (!isAdminUser) continue;
          const arg = cmd.split(/\s+/)[1]?.toLowerCase();
          if (arg === "on") {
            currentSettings.features.antiDelete = true;
            applySettings(currentSettings);
            await sock.sendMessage(chatJid, { text: "✅ Anti-delete enabled" });
          } else if (arg === "off") {
            currentSettings.features.antiDelete = false;
            applySettings(currentSettings);
            await sock.sendMessage(chatJid, { text: "🚫 Anti-delete disabled" });
          } else {
            await sock.sendMessage(chatJid, { text: `ℹ️ Anti-delete is ${currentSettings.features.antiDelete ? "on" : "off"}\nUsage: \`antidelete on\` or \`antidelete off\`` });
          }
          continue;
        }

        if (cmd.startsWith("ai")) {
          if (!isAdminUser) continue;
          const arg = cmd.split(/\s+/)[1]?.toLowerCase();
          if (arg === "on") {
            currentSettings.features.aiChat = true;
            applySettings(currentSettings);
            await sock.sendMessage(chatJid, { text: "✅ AI chat enabled" });
          } else if (arg === "off") {
            currentSettings.features.aiChat = false;
            applySettings(currentSettings);
            await sock.sendMessage(chatJid, { text: "🚫 AI chat disabled" });
          } else {
            await sock.sendMessage(chatJid, { text: `ℹ️ AI chat is ${currentSettings.features.aiChat ? "on" : "off"}\nUsage: \`ai on\` or \`ai off\`` });
          }
          continue;
        }

        if (cmd.startsWith("welcome") || cmd.startsWith("goodbye")) {
          if (!isAdminUser) continue;
          const arg = cmd.split(/\s+/)[1]?.toLowerCase();
          if (arg === "on") {
            currentSettings.features.welcomeGoodbye = true;
            applySettings(currentSettings);
            await sock.sendMessage(chatJid, { text: "✅ Welcome/Goodbye messages enabled" });
          } else if (arg === "off") {
            currentSettings.features.welcomeGoodbye = false;
            applySettings(currentSettings);
            await sock.sendMessage(chatJid, { text: "🚫 Welcome/Goodbye messages disabled" });
          } else {
            await sock.sendMessage(chatJid, { text: `ℹ️ Welcome/Goodbye is ${currentSettings.features.welcomeGoodbye ? "on" : "off"}\nUsage: \`welcome on/off\` or \`goodbye on/off\`` });
          }
          continue;
        }

        if (cmd === "status") {
          if (!isAdminUser) continue;
          const features = currentSettings.features;
          await sock.sendMessage(chatJid, {
            text: `📊 *Bot Status*\n\n` +
              `*Auto-react:* ${features.autoReact ? "✅" : "🚫"}\n` +
              `*Auto-typing:* ${features.autoPresence ? "✅" : "🚫"}\n` +
              `*Anti-delete:* ${features.antiDelete ? "✅" : "🚫"}\n` +
              `*AI chat:* ${features.aiChat ? "✅" : "🚫"}\n` +
              `*Reply mode:* ${features.replyMode}\n` +
              `*Welcome/Goodbye:* ${features.welcomeGoodbye ? "✅" : "🚫"}\n` +
              `*View-once save:* ${features.viewOnce ? "✅" : "🚫"}\n` +
              `*Status save:* ${features.saveStatus ? "✅" : "🚫"}\n` +
              `*Profile save:* ${features.saveProfile ? "✅" : "🚫"}\n` +
              `*Custom commands:* ${features.customCommands ? "✅" : "🚫"}`
          });
          continue;
        }

        // ── AI Chat / Rules ────────────────────────────────────────────────
        if (currentSettings.features.aiChat) {
          const senderJid = msg.key.participant ?? msg.key.remoteJid ?? "";
          if (!isAdminUser && currentSettings.features.replyMode === "only") continue;

          const messageText = text.trim();
          if (!messageText) continue;

          // Check AI rules first
          const rules = currentSettings.aiRules || [];
          const matchedRule = rules.find(r => r.enabled && matchRule(r, messageText));
          if (matchedRule) {
            let response = matchedRule.response;
            // Support variable substitution
            response = response.replace(/{sender}/g, senderJid.split("@")[0] || "you");
            await sock.sendMessage(chatJid, { text: response }, { quoted: msg });
            continue;
          }

          // Fallback to AI provider
          const provider = currentSettings.aiProviders?.find(p => p.id === currentSettings.defaultAiProvider) || currentSettings.aiProviders?.[0];
          if (provider) {
            await handleAiReply(sock, msg, chatJid, senderJid, provider, logCb);
            continue;
          }
        }
      }
    });

  } catch (err) {
    state._starting = false;
    addLog(state, `Init error: ${(err as Error).message}`);
    if (!state._stopRequested) {
      state._retryCount++;
      const delay = Math.min(5000 * state._retryCount, 30000);
      setTimeout(() => startSession(id), delay);
    }
  }
}

export async function startBot() {
  const list = loadSessionIds();
  if (list.length === 0) {
    console.log(`ℹ️ No saved sessions to restore. Create one via /admin`);
    return;
  }

  console.log(`🔄 Restoring ${list.length} session(s)...`);
  for (const { id, label } of list) {
    try {
      await startSession(id, label);
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`Failed to restore session ${id}:`, e);
    }
  }
}
