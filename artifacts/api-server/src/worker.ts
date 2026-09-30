/**
 * Worker – runs ONE WhatsApp session as a child process.
 * Full features + Supabase uploads + autotyping toggle + .savepp <number>
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
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import pino from "pino";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const SESSION_ID = process.env.WORKER_SESSION_ID || "";
const PAIRING_PHONE = process.env.WORKER_PHONE || "";
const PHONE = SESSION_ID.replace(/^user_/, "");

if (!SESSION_ID) {
    console.error("Worker: missing WORKER_SESSION_ID");
    process.exit(1);
}

const BASE_DIR = path.join(process.cwd(), "data");
const AUTH_DIR = path.join(BASE_DIR, "sessions", SESSION_ID, "auth");
const MEDIA_DIR = path.join(BASE_DIR, "sessions", SESSION_ID, "media");
fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    { realtime: { transport: ws as any } }
);

function ipc(msg: any) {
    try { if (process.send && process.connected) process.send(msg); } catch { }
}

function log(text: string) {
    console.log(`[${SESSION_ID}] ${text}`);
    ipc({ type: "log", text });
}

let pairingRequested = false;
let sock: any = null;
let stopping = false;
let autoTypingEnabled = true;   // default ON

// ── Helpers ───────────────────────────────────────────────────────────
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

function getOwnerJid(): string | null {
    const raw = sock?.user?.id ?? sock?.user?.lid;
    if (!raw) return null;
    try {
        const n = jidNormalizedUser(raw);
        if (n?.includes("@")) return n;
    } catch { }
    const num = raw.split(":")[0]?.split("@")[0];
    if (num && /^\d+$/.test(num)) return `${num}@s.whatsapp.net`;
    return null;
}

function isFromMe(msg: any): boolean {
    const ownerJid = getOwnerJid();
    if (!ownerJid) return false;
    const sender = msg.key.participant ?? msg.key.remoteJid ?? "";
    return sender === ownerJid || msg.key.fromMe === true;
}

function getText(msg: any): string {
    const m = msg.message;
    if (!m) return "";
    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    return "";
}

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

async function saveAndUpload(
    buffer: Buffer,
    filename: string,
    mime: string,
): Promise<string | null> {
    try { fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer); } catch { }

    try {
        const storagePath = `${PHONE}/${filename}`;
        const { error } = await supabase.storage
            .from("saved_media")
            .upload(storagePath, buffer, {
                contentType: mime || "application/octet-stream",
                cacheControl: "3600",
                upsert: false,
            });
        if (error) {
            log(`❌ Supabase upload failed: ${error.message}`);
            return null;
        }
        const { data } = supabase.storage.from("saved_media").getPublicUrl(storagePath);
        log(`☁️ Uploaded: ${storagePath}`);
        return data?.publicUrl ?? null;
    } catch (e) {
        log(`❌ Supabase upload exception: ${(e as Error).message}`);
        return null;
    }
}

async function sendToOwnerDM(
    buffer: Buffer,
    mediaType: "image" | "video" | "audio",
    mime: string | undefined,
    caption: string,
): Promise<boolean> {
    const ownerJid = getOwnerJid();
    if (!ownerJid) return false;
    try {
        if (mediaType === "image") await sock.sendMessage(ownerJid, { image: buffer, caption });
        else if (mediaType === "video") await sock.sendMessage(ownerJid, { video: buffer, caption });
        else await sock.sendMessage(ownerJid, { audio: buffer, mimetype: mime ?? "audio/ogg; codecs=opus", ptt: true });
        log(`✅ Sent to owner DM`);
        return true;
    } catch (e) {
        log(`❌ DM send failed: ${(e as Error).message}`);
        return false;
    }
}

// ── View-once cache ────────────────────────────────────────────────────
const viewOnceCache = new Map<string, {
    mediaMsg: MediaMsg;
    mediaType: "image" | "video" | "audio";
    chatJid: string;
    senderJid: string;
}>();

// ── Features ───────────────────────────────────────────────────────────
async function handleViewOnce(msg: any, chatJid: string) {
    const m = msg.message;
    if (m.conversation) return;
    if (m.extendedTextMessage?.text) return;

    const extracted = extractViewOnceMedia(msg.message);
    if (!extracted) return;
    const ownerJid = getOwnerJid();
    if (!ownerJid) return;

    const isGroup = chatJid.endsWith("@g.us");
    const senderJid = isGroup ? (msg.key.participant ?? chatJid) : chatJid;
    const fromLabel = senderJid.split("@")[0] ?? "unknown";
    const inLabel = isGroup ? ` in group ${chatJid.split("@")[0]}` : "";

    const msgId = msg.key.id;
    if (msgId) {
        viewOnceCache.set(msgId, {
            mediaMsg: extracted.mediaMsg,
            mediaType: extracted.mediaType,
            chatJid,
            senderJid,
        });
        log(`📦 Cached view-once ID: ${msgId}`);
    }

    log(`📥 View-once ${extracted.mediaType} from +${fromLabel}${inLabel}`);
    try {
        const buffer = await downloadMedia(extracted.mediaMsg, extracted.mediaType);
        const ext = mimeToExt(extracted.mediaMsg.mimetype);
        const mime = extracted.mediaMsg.mimetype ?? "application/octet-stream";
        const filename = `vo_${Date.now()}_${fromLabel}.${ext}`;

        const url = await saveAndUpload(buffer, filename, mime);
        const caption =
            `🔓 *View-once ${extracted.mediaType}* (auto-saved)\n` +
            `From: +${fromLabel}${inLabel}` +
            (url ? `\n\n📁 ${url}` : `\n\n_⚠️ Cloud upload failed_`);

        await sendToOwnerDM(buffer, extracted.mediaType, mime, caption);
    } catch (e) {
        log(`⚠️ Auto-capture failed: ${(e as Error).message}`);
    }
}

async function handleReaction(msg: any) {
    const reaction = msg.message?.reactionMessage;
    if (!reaction) return;
    const emoji = reaction.text ?? "";
    const TRIGGERS = new Set(["🙂", "😣", "🤪", "😇", "🥺"]);
    if (!TRIGGERS.has(emoji)) return;
    if (!isFromMe(msg)) return;

    const originalId = reaction.key?.id ?? "";
    log(`🔁 Owner reacted ${emoji} on ${originalId}`);

    const cached = viewOnceCache.get(originalId);
    if (!cached) {
        log(`❌ Not in cache: ${originalId}`);
        return;
    }

    try {
        const buffer = await downloadMedia(cached.mediaMsg, cached.mediaType);
        const ext = mimeToExt(cached.mediaMsg.mimetype);
        const mime = cached.mediaMsg.mimetype ?? "application/octet-stream";
        const filename = `vo_react_${Date.now()}.${ext}`;

        const url = await saveAndUpload(buffer, filename, mime);
        const caption =
            `🔓 *View-once ${cached.mediaType}* (via ${emoji})\n` +
            `From: +${cached.senderJid.split("@")[0]}` +
            (url ? `\n\n📁 ${url}` : "");

        await sendToOwnerDM(buffer, cached.mediaType, mime, caption);
    } catch (e) {
        log(`❌ Reaction download failed: ${(e as Error).message}`);
    }
}

async function handleSaveStatus(msg: any, chatJid: string) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    if (!ctx?.quotedMessage) return false;
    if (ctx.remoteJid !== "status@broadcast") return false;

    const quoted = ctx.quotedMessage as Record<string, any>;
    const media = (quoted.imageMessage || quoted.videoMessage || quoted.audioMessage) as MediaMsg | undefined;
    if (!media) return false;

    try {
        const type: "image" | "video" | "audio" = quoted.imageMessage ? "image" : quoted.videoMessage ? "video" : "audio";
        const buffer = await downloadMedia(media, type);
        const ext = mimeToExt(media.mimetype);
        const mime = media.mimetype ?? "application/octet-stream";
        const filename = `status_${Date.now()}.${ext}`;

        const url = await saveAndUpload(buffer, filename, mime);

        // ── Short confirmation in the original chat ────────────────────
        await sock.sendMessage(chatJid, { text: `✅ Status saved` });

        // ── Send actual file to owner's own DM ─────────────────────────
        const ownerJid = getOwnerJid();
        if (ownerJid) {
            const posterJid = ctx.participant ?? ctx.remoteJid ?? "";
            const posterNum = posterJid.split("@")[0]?.split(":")[0] ?? "unknown";
            const caption =
                `🔓 *Status ${type}*\n` +
                `From: +${posterNum}` +
                (url ? `\n\n📁 ${url}` : "");

            if (type === "image") await sock.sendMessage(ownerJid, { image: buffer, caption });
            else if (type === "video") await sock.sendMessage(ownerJid, { video: buffer, caption });
            else await sock.sendMessage(ownerJid, { audio: buffer, mimetype: mime, ptt: true });
        }

        log(`💾 Saved status: ${filename}`);
        return true;
    } catch (e) {
        log(`❌ Save status failed: ${(e as Error).message}`);
        return false;
    }
}

async function handleSticker(msg: any, chatJid: string) {
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
            await sock.sendMessage(chatJid, { document: buffer, mimetype: "video/mp4", fileName: "sticker.mp4" });
            return true;
        }
        await sock.sendMessage(chatJid, { sticker: stickerBuffer });
        log(`✅ Sticker sent`);
        return true;
    } catch (e) {
        log(`❌ Sticker failed: ${(e as Error).message}`);
        return false;
    }
}

// ── .savepp [number] ──────────────────────────────────────────────────
async function handleSavePP(msg: any, chatJid: string, args: string[]) {
    // If number provided, use it. Otherwise use the sender.
    let targetJid: string;

    if (args[0]) {
        const number = args[0].replace(/\D/g, "");
        if (number.length < 10) {
            await sock.sendMessage(chatJid, {
                text: `❌ Invalid number.\n\n*Usage:* \`savepp 2348103077073\``,
            });
            return false;
        }
        targetJid = `${number}@s.whatsapp.net`;
    } else {
        targetJid = msg.key.participant ?? msg.key.remoteJid ?? chatJid;
    }

    try {
        const pp = await sock.profilePictureUrl(targetJid, "image");
        if (!pp) {
            await sock.sendMessage(chatJid, { text: `❌ No profile picture available for that number.` });
            return false;
        }
        const resp = await fetch(pp);
        const buffer = Buffer.from(await resp.arrayBuffer());
        const filename = `pp_${targetJid.split("@")[0]}_${Date.now()}.jpg`;

        const url = await saveAndUpload(buffer, filename, "image/jpeg");
        const replyText = url
            ? `✅ *Profile picture saved*\n\n📁 ${url}`
            : `✅ Saved locally (cloud upload failed)`;
        await sock.sendMessage(chatJid, { text: replyText });
        log(`💾 Saved PP: ${filename}`);
        return true;
    } catch (e) {
        log(`❌ Save PP failed: ${(e as Error).message}`);
        return false;
    }
}

async function handleVv(msg: any, chatJid: string) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    if (!ctx?.quotedMessage) return false;
    const quoted = ctx.quotedMessage as Record<string, unknown>;
    const extracted = extractViewOnceFromQuoted(quoted);
    if (!extracted) return false;
    const ownerJid = getOwnerJid();
    if (!ownerJid) return false;
    try {
        const buffer = await downloadMedia(extracted.mediaMsg, extracted.mediaType);
        const ext = mimeToExt(extracted.mediaMsg.mimetype);
        const mime = extracted.mediaMsg.mimetype ?? "application/octet-stream";
        const filename = `vv_${Date.now()}.${ext}`;

        const url = await saveAndUpload(buffer, filename, mime);
        const caption =
            `🔓 *View-once ${extracted.mediaType} (.vv)*` +
            (url ? `\n\n📁 ${url}` : "");

        await sendToOwnerDM(buffer, extracted.mediaType, mime, caption);
        return true;
    } catch (e) {
        log(`❌ .vv failed: ${(e as Error).message}`);
        return false;
    }
}

async function handleStatusReaction(msg: any) {
    const chatJid = msg.key.remoteJid || "";
    if (chatJid !== "status@broadcast") return;
    if (isFromMe(msg)) return;
    const REACTIONS = ["❤️", "🔥", "🥰", "😍", "💯", "😘", "👏", "🙌", "🤗", "✨", "💖", "🌟"];
    const emoji = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
    try {
        await sock.sendMessage(chatJid, { react: { text: emoji, key: msg.key } });
        log(`✅ Liked status with ${emoji}`);
    } catch (e) {
        log(`❌ Status like failed: ${(e as Error).message}`);
    }
}

// ── MAIN ───────────────────────────────────────────────────────────────
async function run() {
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const logger = pino({ level: "silent" });
    sock = makeWASocket({
        version,
        auth: {
            creds: authState.creds,
            keys: makeCacheableSignalKeyStore(authState.keys, logger),
        },
        browser: Browsers.ubuntu(`NovaBot-${SESSION_ID}`),
        printQRInTerminal: false,
        syncFullHistory: false,
        connectTimeoutMs: 30_000,
        keepAliveIntervalMs: 10_000,
        logger,
        getMessage: async () => ({ conversation: "" }),
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            ipc({ type: "qr", qr });
            if (PAIRING_PHONE && !pairingRequested && !authState.creds.registered) {
                pairingRequested = true;
                try {
                    const cleanPhone = PAIRING_PHONE.replace(/\D/g, "");
                    const code = await sock.requestPairingCode(cleanPhone);
                    ipc({ type: "pairing", code });
                    log(`Pairing code: ${code}`);
                } catch (e) {
                    ipc({ type: "pairing_error", error: (e as Error).message });
                    pairingRequested = false;
                }
            }
        }

        if (connection === "open") {
            const phoneNumber = sock.user?.id?.split(":")[0];
            ipc({ type: "connected", phoneNumber });
            log(`✅ Connected as +${phoneNumber}`);
        }

        if (connection === "close") {
            const err = lastDisconnect?.error as Boom | undefined;
            const code = err?.output?.statusCode ?? 0;
            ipc({ type: "disconnected", code });

            if (stopping) return;
            if (pairingRequested && !authState.creds.registered) {
                log("Socket closed during pairing — not reconnecting");
                return;
            }
            if (code === DisconnectReason.loggedOut) {
                log("Logged out — clearing auth");
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                fs.mkdirSync(AUTH_DIR, { recursive: true });
                ipc({ type: "logged_out" });
                return;
            }
            setTimeout(() => run().catch(() => { }), 3000);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }: any) => {
        for (const msg of messages) {
            if (!msg.message) continue;
            const chatJid = msg.key.remoteJid || "";
            const isStatus = chatJid === "status@broadcast";

            if (msg.message?.reactionMessage) {
                await handleReaction(msg);
                continue;
            }

            if (isStatus) {
                await handleStatusReaction(msg);
                continue;
            }

            // ── Autotyping indicator ───────────────────────────────────────
            if (autoTypingEnabled && !isFromMe(msg)) {
                try { await sock.sendPresenceUpdate("composing", chatJid); } catch { }
            }

            await handleViewOnce(msg, chatJid);

            const text = getText(msg);
            if (!text) continue;
            const lower = text.trim().toLowerCase();
            const cmd = lower.replace(/^\./, "");
            const args = text.trim().split(/\s+/).slice(1);

            if (cmd === "ping") {
                await sock.sendMessage(chatJid, { text: "🏓 Pong!" });
                continue;
            }
            if (cmd === "save") { await handleSaveStatus(msg, chatJid); continue; }
            if (cmd === "sticker") { await handleSticker(msg, chatJid); continue; }
            if (cmd === "savepp") { await handleSavePP(msg, chatJid, args); continue; }
            if (cmd === "vv") { await handleVv(msg, chatJid); continue; }

            if (cmd === "autotyping on") {
                autoTypingEnabled = true;
                await sock.sendMessage(chatJid, { text: "✍️ Auto-typing *ON*" });
                log(`Autotyping ON`);
                continue;
            }
            if (cmd === "autotyping off") {
                autoTypingEnabled = false;
                await sock.sendMessage(chatJid, { text: "🚫 Auto-typing *OFF*" });
                log(`Autotyping OFF`);
                continue;
            }

            if (cmd === "files" || cmd === "myfiles") {
                const publicUrl = process.env.PUBLIC_URL || "http://localhost:8080";
                await sock.sendMessage(chatJid, {
                    text:
                        `📁 *Your Saved Files*\n\n` +
                        `Login with your phone number and PIN at:\n\n` +
                        `${publicUrl}/my-files\n\n` +
                        `_Phone:_ \`${PHONE}\``,
                });
                continue;
            }

            if (cmd === "menu" || cmd === "help") {
                await sock.sendMessage(chatJid, {
                    text:
                        `╭━━━━━━━━━━━━━━━━━╮\n` +
                        `   🤖 *WHATSAPP BOT*\n` +
                        `╰━━━━━━━━━━━━━━━━━╯\n\n` +
                        `⚡ *BASICS*\n` +
                        `├ \`ping\` — check if alive\n` +
                        `├ \`menu\` — show this menu\n` +
                        `└ \`files\` — view saved files\n\n` +
                        `📸 *MEDIA*\n` +
                        `├ \`vv\` — reply to view-once to save\n` +
                        `├ \`sticker\` — reply to image/video\n` +
                        `├ \`save\` — reply to a status\n` +
                        `└ \`savepp <number>\` — save profile pic\n\n` +
                        `✍️ *PRESENCE*\n` +
                        `├ \`autotyping on\` — show typing\n` +
                        `└ \`autotyping off\` — hide typing\n\n` +
                        `_Type any command with or without the dot._`,
                });
                continue;
            }
        }
    });

    ipc({ type: "started", sessionId: SESSION_ID });
}

// Keep alive
const keepAlive = setInterval(() => { }, 30_000);

process.on("message", (msg: any) => {
    if (msg?.type === "kill") {
        stopping = true;
        clearInterval(keepAlive);
        try { sock?.end(undefined); } catch { }
        setTimeout(() => process.exit(0), 500);
    }
});

process.on("SIGTERM", () => { clearInterval(keepAlive); process.exit(0); });
process.on("SIGINT", () => { clearInterval(keepAlive); process.exit(0); });

run().catch((err) => {
    console.error(`[${SESSION_ID}] Worker crashed:`, err);
    ipc({ type: "error", error: (err as Error).message });
});