import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import { downloadContentFromMessage, toBuffer, jidNormalizedUser } from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import { objectStorageClient } from "../objectStorage";

const BUCKET_ID  = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"] ?? "";
const VO_PREFIX  = "view-once";
// Must match whatsapp-bot.ts BASE_DIR — use workspace dir (persistent in Replit Autoscale)
const BASE_DIR   = path.join(process.cwd(), "data");
const LOCAL_DIR  = path.join(BASE_DIR, "saved_media");
const CACHE_FILE = path.join(BASE_DIR, "vo-cache.json");

// ── Trigger emoji ─────────────────────────────────────────────────────────────
export const TRIGGER_EMOJIS = new Set(["🙂", "😣", "🤪", "😇", "🥺"]);

// ── Persistent cache ──────────────────────────────────────────────────────────
// Written to disk the INSTANT a view-once arrives — before any download attempt.
// This means the emoji reaction can always trigger a download, even if
// auto-capture already failed or the server restarted.
interface PersistEntry {
  // Set immediately on arrival:
  chatJid:    string;
  senderJid:  string;
  mediaType:  "image" | "video" | "audio";
  mediaMsg:   { url?: string; directPath?: string; mediaKey?: unknown; mimetype?: string };
  savedAt:    number;
  // Filled in after successful upload:
  gcsObjectName?: string;
}
type PersistMap = Record<string, PersistEntry>;

function loadPCache(): PersistMap {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as PersistMap; }
  catch { return {}; }
}
function savePCache(map: PersistMap): void {
  try {
    const trimmed = Object.fromEntries(
      Object.entries(map)
        .sort(([, a], [, b]) => b.savedAt - a.savedAt)
        .slice(0, 300)
    );
    fs.mkdirSync(BASE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(trimmed));
  } catch { /* ignore */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mimeToExt(mime?: string | null): string {
  if (!mime) return "bin";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("png"))   return "png";
  if (mime.includes("mp4") || mime.includes("video")) return "mp4";
  if (mime.includes("webp"))  return "webp";
  if (mime.includes("ogg") || mime.includes("opus"))  return "ogg";
  return "bin";
}

type MediaMsg = { url?: string; directPath?: string; mediaKey?: unknown; mimetype?: string };

function extractViewOnceMedia(message: WAMessage["message"]): {
  mediaMsg: MediaMsg; mediaType: "image" | "video" | "audio";
} | null {
  const inner =
    (message?.viewOnceMessage?.message            as Record<string, unknown> | undefined) ??
    (message?.viewOnceMessageV2?.message          as Record<string, unknown> | undefined) ??
    (message?.viewOnceMessageV2Extension?.message as Record<string, unknown> | undefined);
  if (!inner) return null;
  const img = inner["imageMessage"] as MediaMsg | undefined;
  const vid = inner["videoMessage"] as MediaMsg | undefined;
  const aud = inner["audioMessage"] as MediaMsg | undefined;
  if (img) return { mediaMsg: img, mediaType: "image" };
  if (vid) return { mediaMsg: vid, mediaType: "video" };
  if (aud) return { mediaMsg: aud, mediaType: "audio" };
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

function getOwnerJid(sock: WASocket, addLog: (s: string) => void): string | null {
  const raw = sock.user?.id ?? (sock.user as { lid?: string } | undefined)?.lid;
  if (!raw) { addLog("Owner JID: sock.user empty"); return null; }
  try {
    const n = jidNormalizedUser(raw);
    if (n?.includes("@")) return n;
  } catch { /* fall through */ }
  const num = raw.split(":")[0]?.split("@")[0];
  if (num && /^\d+$/.test(num)) return `${num}@s.whatsapp.net`;
  addLog(`Owner JID parse failed: ${raw}`);
  return null;
}

async function downloadMedia(
  mediaMsg: MediaMsg,
  mediaType: "image" | "video" | "audio",
): Promise<Buffer> {
  // downloadContentFromMessage expects the mediaKey as Uint8Array
  const stream = await downloadContentFromMessage(
    mediaMsg as Parameters<typeof downloadContentFromMessage>[0],
    mediaType,
  );
  return toBuffer(stream);
}

async function uploadGCS(
  buffer: Buffer, filename: string, mime: string,
  addLog: (s: string) => void,
): Promise<string | null> {
  if (!BUCKET_ID) return null;
  try {
    const objectName = `${VO_PREFIX}/${filename}`;
    await objectStorageClient.bucket(BUCKET_ID).file(objectName).save(buffer, {
      contentType: mime || "application/octet-stream",
      resumable: false,
    });
    addLog(`☁️ Saved to storage: ${objectName} (${Math.round(buffer.length / 1024)} KB)`);
    return objectName;
  } catch (e) {
    addLog(`GCS upload failed: ${(e as Error).message}`);
    return null;
  }
}

async function sendToOwnerDM(
  sock: WASocket, ownerJid: string,
  buffer: Buffer, mediaType: "image" | "video" | "audio",
  mime: string | undefined, caption: string,
  addLog: (s: string) => void,
): Promise<boolean> {
  try {
    if (mediaType === "image")      await sock.sendMessage(ownerJid, { image: buffer, caption });
    else if (mediaType === "video") await sock.sendMessage(ownerJid, { video: buffer, caption });
    else {
      await sock.sendMessage(ownerJid, { audio: buffer, mimetype: mime ?? "audio/ogg; codecs=opus", ptt: true });
      await sock.sendMessage(ownerJid, { text: caption });
    }
    addLog(`✅ Sent to owner DM (+${ownerJid.split("@")[0]})`);
    return true;
  } catch (e) {
    addLog(`DM send failed: ${(e as Error).message}`);
    return false;
  }
}

// ── Public: cache view-once IMMEDIATELY on arrival ───────────────────────────
// Called for every incoming message. If it's a view-once, the media descriptor
// is written to disk right away — BEFORE any download attempt.
// This guarantees the emoji reaction always has something to work with.

export function cacheViewOnceMessage(msg: WAMessage): void {
  const chatJid = msg.key.remoteJid;
  const msgId   = msg.key.id;
  if (!chatJid || !msgId || msg.key.fromMe) return;

  const extracted = extractViewOnceMedia(msg.message);
  if (!extracted) return;

  const isGroup   = chatJid.endsWith("@g.us");
  const senderJid = isGroup ? (msg.key.participant ?? chatJid) : chatJid;

  // Write to persistent cache immediately (descriptor saved to disk)
  const pc = loadPCache();
  if (!pc[msgId]) {
    pc[msgId] = {
      chatJid,
      senderJid,
      mediaType:  extracted.mediaType,
      mediaMsg:   extracted.mediaMsg,
      savedAt:    Date.now(),
    };
    savePCache(pc);
  }
}

// ── Public: silent auto-capture ───────────────────────────────────────────────
// Attempts to download + send to DM immediately on arrival.
// If this succeeds, gcsObjectName is filled in the persistent cache entry.
// If it fails, the persistent cache still has the descriptor → emoji trigger works.

export async function handleViewOnce(
  sock: WASocket,
  msg: WAMessage,
  chatJid: string,
  addSavedFile: (f: string) => void,
  addLog: (s: string) => void,
): Promise<void> {
  const msgId = msg.key.id;
  if (!msgId) return;

  const extracted = extractViewOnceMedia(msg.message);
  if (!extracted) return;

  const ownerJid = getOwnerJid(sock, addLog);
  if (!ownerJid) { addLog("Auto-capture: owner JID unknown"); return; }

  const isGroup   = chatJid.endsWith("@g.us");
  const senderJid = isGroup ? (msg.key.participant ?? chatJid) : chatJid;
  const fromLabel = senderJid.split("@")[0] ?? "unknown";
  const inLabel   = isGroup ? ` in group ${chatJid.split("@")[0]}` : "";

  addLog(`📥 View-once ${extracted.mediaType} from +${fromLabel}${inLabel} — auto-capturing…`);

  try {
    const buffer   = await downloadMedia(extracted.mediaMsg, extracted.mediaType);
    const ext      = mimeToExt(extracted.mediaMsg.mimetype);
    const mime     = extracted.mediaMsg.mimetype ?? "application/octet-stream";
    const filename = `vo_${Date.now()}_${fromLabel}.${ext}`;

    // Save to GCS + local
    const gcsName = await uploadGCS(buffer, filename, mime, addLog);
    try { fs.mkdirSync(LOCAL_DIR, { recursive: true }); fs.writeFileSync(path.join(LOCAL_DIR, filename), buffer); } catch { /* ignore */ }
    addSavedFile(filename);

    // Update persistent cache with GCS object name
    if (gcsName) {
      const pc = loadPCache();
      if (pc[msgId]) { pc[msgId]!.gcsObjectName = gcsName; savePCache(pc); }
    }

    // Forward to owner DM
    const caption = `🔓 *View-once ${extracted.mediaType}* (auto-saved)\nFrom: +${fromLabel}${inLabel}\n💾 Also in Media Library on dashboard`;
    await sendToOwnerDM(sock, ownerJid, buffer, extracted.mediaType, extracted.mediaMsg.mimetype, caption, addLog);

  } catch (e) {
    addLog(`⚠️ Auto-capture failed: ${(e as Error).message}`);
    addLog(`→ React with 🙂 within 15 min to save manually`);
  }
}

// ── Public: reaction-triggered save ──────────────────────────────────────────
// MUST be called outside the type="notify" filter — owner reactions are type="append".

export async function handleViewOnceReaction(
  sock: WASocket,
  msg: WAMessage,
  addSavedFile: (f: string) => void,
  addLog: (s: string) => void,
): Promise<void> {
  const reaction = msg.message?.reactionMessage;
  if (!reaction) return;

  const emoji = reaction.text ?? "";
  if (!TRIGGER_EMOJIS.has(emoji)) return;

  // Verify it's the bot owner reacting
  const ownerJid = getOwnerJid(sock, addLog);
  if (!ownerJid) return;
  const ownerNum   = ownerJid.split("@")[0] ?? "";
  const reactorJid = msg.key.participant ?? msg.key.remoteJid ?? "";
  const reactorNum = reactorJid.split("@")[0]?.split(":")[0] ?? "";
  const isOwner    = msg.key.fromMe || reactorNum === ownerNum;
  if (!isOwner) return;

  // reaction.key is the key of the ORIGINAL message that was reacted to
  const originalId = reaction.key?.id ?? "";
  addLog(`Owner reacted ${emoji} on msg ${originalId}`);

  const pc    = loadPCache();
  const entry = pc[originalId];

  if (!entry) {
    addLog(`Not found in cache for ${originalId}`);
    return; // silent — nothing to send
  }

  const fromLabel = entry.senderJid.split("@")[0] ?? "unknown";
  const inLabel   = entry.chatJid.endsWith("@g.us") ? ` in group ${entry.chatJid.split("@")[0]}` : "";
  const caption   = `🔓 *View-once ${entry.mediaType}* (saved via ${emoji})\nFrom: +${fromLabel}${inLabel}`;

  // ── Path A: already downloaded → fetch from GCS ───────────────────────────
  if (entry.gcsObjectName && BUCKET_ID) {
    addLog(`Found in GCS: ${entry.gcsObjectName} — fetching…`);
    try {
      const file = objectStorageClient.bucket(BUCKET_ID).file(entry.gcsObjectName);
      const [exists] = await file.exists();
      if (exists) {
        const [raw] = await file.download();
        await sendToOwnerDM(sock, ownerJid, Buffer.from(raw), entry.mediaType, undefined, caption, addLog);
        return;
      }
      addLog(`GCS file missing — trying fresh download`);
    } catch (e) {
      addLog(`GCS fetch failed: ${(e as Error).message} — trying fresh download`);
    }
  }

  // ── Path B: not yet downloaded → use saved descriptor to download now ─────
  addLog(`Downloading fresh from WhatsApp…`);
  try {
    const buffer   = await downloadMedia(entry.mediaMsg as MediaMsg, entry.mediaType);
    const ext      = mimeToExt(entry.mediaMsg.mimetype);
    const mime     = entry.mediaMsg.mimetype ?? "application/octet-stream";
    const filename = `vo_react_${Date.now()}_${fromLabel}.${ext}`;

    const gcsName = await uploadGCS(buffer, filename, mime, addLog);
    try { fs.mkdirSync(LOCAL_DIR, { recursive: true }); fs.writeFileSync(path.join(LOCAL_DIR, filename), buffer); } catch { /* ignore */ }
    addSavedFile(filename);

    // Update persistent cache
    if (gcsName) { entry.gcsObjectName = gcsName; savePCache(pc); }

    await sendToOwnerDM(sock, ownerJid, buffer, entry.mediaType, entry.mediaMsg.mimetype, caption, addLog);
  } catch (e) {
    addLog(`Fresh download failed: ${(e as Error).message}`);
    // silent — log only, no message sent
  }
}

// ── Public: .vv command ───────────────────────────────────────────────────────

export async function handleVvCommand(
  sock: WASocket,
  msg: WAMessage,
  chatJid: string,
  _privateDm: string,
  addSavedFile: (f: string) => void,
  addLog: (s: string) => void,
): Promise<void> {
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  if (!ctxInfo?.quotedMessage) return; // silent — nothing quoted

  const quoted    = ctxInfo.quotedMessage as Record<string, unknown>;
  const extracted = extractViewOnceFromQuoted(quoted);
  if (!extracted) return; // silent — not a view-once

  const ownerJid = getOwnerJid(sock, addLog);
  if (!ownerJid) return; // silent — no owner

  const isGroup   = chatJid.endsWith("@g.us");
  const senderJid = isGroup ? (msg.key.participant ?? chatJid) : chatJid;
  const fromLabel = senderJid.split("@")[0] ?? "unknown";
  const inLabel   = isGroup ? ` in group ${chatJid.split("@")[0]}` : "";

  try {
    addLog(`.vv — downloading ${extracted.mediaType}…`);
    const buffer   = await downloadMedia(extracted.mediaMsg, extracted.mediaType);
    const ext      = mimeToExt(extracted.mediaMsg.mimetype);
    const mime     = extracted.mediaMsg.mimetype ?? "application/octet-stream";
    const filename = `vv_${Date.now()}_${fromLabel}.${ext}`;

    const gcsName = await uploadGCS(buffer, filename, mime, addLog);
    try { fs.mkdirSync(LOCAL_DIR, { recursive: true }); fs.writeFileSync(path.join(LOCAL_DIR, filename), buffer); } catch { /* ignore */ }
    addSavedFile(filename);

    const caption = `🔓 *View-once ${extracted.mediaType} (.vv)*\nFrom: +${fromLabel}${inLabel}`;
    await sendToOwnerDM(sock, ownerJid, buffer, extracted.mediaType, extracted.mediaMsg.mimetype, caption, addLog);
    void gcsName; // already logged inside uploadGCS
  } catch (e) {
    addLog(`.vv failed: ${(e as Error).message}`);
    // silent — no in-chat reply
  }
}
