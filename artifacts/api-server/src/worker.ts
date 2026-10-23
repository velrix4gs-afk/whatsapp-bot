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

if (!SESSION_ID) process.exit(1);

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

function ipc(msg: any) { try { if (process.send && process.connected) process.send(msg); } catch { } }
function log(text: string) { console.log(`[${SESSION_ID}] ${text}`); ipc({ type: "log", text }); }

let pairingRequested = false;
let sock: any = null;
let stopping = false;
let autoTypingEnabled = true;

function mimeToExt(mime?: string | null): string {
    if (!mime) return "bin";
    if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
    if (mime.includes("png")) return "png";
    if (mime.includes("mp4")) return "mp4";
    if (mime.includes("webp")) return "webp";
    if (mime.includes("ogg")) return "ogg";
    return "bin";
}

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
    return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || "";
}

type MediaMsg = { url?: string; directPath?: string; mediaKey?: unknown; mimetype?: string };

async function downloadMedia(mediaMsg: MediaMsg, mediaType: "image" | "video" | "audio"): Promise<Buffer> {
    const stream = await downloadContentFromMessage(mediaMsg as any, mediaType);
    return toBuffer(stream);
}

async function saveToSupabase(buffer: Buffer, filename: string, mime: string): Promise<boolean> {
    try {
        const storagePath = `${PHONE}/${filename}`;
        const { error } = await supabase.storage.from("saved_media").upload(storagePath, buffer, { contentType: mime, upsert: false });
        return !error;
    } catch { return false; }
}

// ── Features ───────────────────────────────────────────────────────────
const viewOnceCache = new Map<string, { mediaMsg: MediaMsg; mediaType: "image" | "video" | "audio"; senderJid: string }>();

async function handleViewOnce(msg: any, chatJid: string) {
    const m = msg.message;
    if (m.conversation || m.extendedTextMessage?.text) return;

    const inner = m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.viewOnceMessageV2Extension?.message;
    let media, type;
    if (inner?.imageMessage) { media = inner.imageMessage; type = "image"; }
    else if (inner?.videoMessage) { media = inner.videoMessage; type = "video"; }
    else if (inner?.audioMessage) { media = inner.audioMessage; type = "audio"; }

    if (!media) return;
    const ownerJid = getOwnerJid();
    if (!ownerJid) return;

    if (msg.key.id) viewOnceCache.set(msg.key.id, { mediaMsg: media, mediaType: type, senderJid: chatJid });

    try {
        const buffer = await downloadMedia(media, type);
        const ext = mimeToExt(media.mimetype);
        const success = await saveToSupabase(buffer, `vo_${Date.now()}.${ext}`, media.mimetype);

        // 🔑 Auto-save DM (No URL, just image and web link)
        const webLink = `${process.env.PUBLIC_URL}/my-files`;
        const caption = `🔓 *View-once ${type}* (auto-saved)\nFrom: +${chatJid.split("@")[0]}\n\n📁 View all files here: ${webLink}` + (success ? "" : "\n_⚠️ Cloud upload failed_");

        if (type === "image") await sock.sendMessage(ownerJid, { image: buffer, caption });
        else if (type === "video") await sock.sendMessage(ownerJid, { video: buffer, caption });
        else await sock.sendMessage(ownerJid, { audio: buffer, mimetype: media.mimetype, ptt: true });
    } catch (e) { log(`VO failed: ${e}`); }
}

async function handleReaction(msg: any) {
    const reaction = msg.message?.reactionMessage;
    if (!reaction || !isFromMe(msg)) return;
    if (!["🙂", "😣", "🤪", "😇", "🥺"].includes(reaction.text)) return;

    const cached = viewOnceCache.get(reaction.key?.id);
    if (!cached) return;

    try {
        const buffer = await downloadMedia(cached.mediaMsg, cached.mediaType);
        const ext = mimeToExt(cached.mediaMsg.mimetype);
        await saveToSupabase(buffer, `vo_react_${Date.now()}.${ext}`, cached.mediaMsg.mimetype);

        const webLink = `${process.env.PUBLIC_URL}/my-files`;
        const caption = `🔓 *View-once ${cached.mediaType}* (via reaction)\nFrom: +${cached.senderJid.split("@")[0]}\n\n📁 View: ${webLink}`;

        if (cached.mediaType === "image") await sock.sendMessage(getOwnerJid()!, { image: buffer, caption });
        else if (cached.mediaType === "video") await sock.sendMessage(getOwnerJid()!, { video: buffer, caption });
        else await sock.sendMessage(getOwnerJid()!, { audio: buffer, mimetype: cached.mediaMsg.mimetype, ptt: true });
    } catch (e) { log(`Reaction failed: ${e}`); }
}

async function handleSaveStatus(msg: any, chatJid: string) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    if (!ctx?.quotedMessage || ctx.remoteJid !== "status@broadcast") return;
    const media = ctx.quotedMessage.imageMessage || ctx.quotedMessage.videoMessage || ctx.quotedMessage.audioMessage;
    if (!media) return;

    try {
        const type = ctx.quotedMessage.imageMessage ? "image" : ctx.quotedMessage.videoMessage ? "video" : "audio";
        const buffer = await downloadMedia(media, type);
        const ext = mimeToExt(media.mimetype);
        await saveToSupabase(buffer, `status_${Date.now()}.${ext}`, media.mimetype);

        await sock.sendMessage(chatJid, { text: "✅ Status saved" });
        const ownerJid = getOwnerJid();
        if (ownerJid) {
            const webLink = `${process.env.PUBLIC_URL}/my-files`;
            const posterNum = ctx.participant?.split("@")[0] || "unknown";
            const caption = `🔓 *Status ${type}*\nFrom: +${posterNum}\n\n📁 View: ${webLink}`;
            if (type === "image") await sock.sendMessage(ownerJid, { image: buffer, caption });
            else if (type === "video") await sock.sendMessage(ownerJid, { video: buffer, caption });
            else await sock.sendMessage(ownerJid, { audio: buffer, mimetype: media.mimetype, ptt: true });
        }
    } catch (e) { log(`Status save failed: ${e}`); }
}

async function handleSavePP(msg: any, chatJid: string, args: string[]) {
    const targetJid = args[0] ? `${args[0].replace(/\D/g, "")}@s.whatsapp.net` : (msg.key.participant ?? msg.key.remoteJid);
    try {
        const pp = await sock.profilePictureUrl(targetJid, "image");
        if (!pp) return sock.sendMessage(chatJid, { text: "❌ No profile picture." });
        const buffer = Buffer.from(await (await fetch(pp)).arrayBuffer());
        await saveToSupabase(buffer, `pp_${targetJid.split("@")[0]}_${Date.now()}.jpg`, "image/jpeg");

        const webLink = `${process.env.PUBLIC_URL}/my-files`;
        await sock.sendMessage(chatJid, { text: `✅ Profile pic saved\n📁 View: ${webLink}` });
    } catch (e) { log(`SavePP failed: ${e}`); }
}

async function handleVv(msg: any, chatJid: string) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    if (!ctx?.quotedMessage) return;
    const inner = ctx.quotedMessage.viewOnceMessage?.message ?? ctx.quotedMessage.viewOnceMessageV2?.message ?? ctx.quotedMessage;
    const media = inner.imageMessage || inner.videoMessage;
    if (!media) return;
    try {
        const type = inner.imageMessage ? "image" : "video";
        const buffer = await downloadMedia(media, type);
        const ext = mimeToExt(media.mimetype);
        await saveToSupabase(buffer, `vv_${Date.now()}.${ext}`, media.mimetype);

        const webLink = `${process.env.PUBLIC_URL}/my-files`;
        const caption = `🔓 *View-once ${type} (.vv)*\n\n📁 View: ${webLink}`;
        if (type === "image") await sock.sendMessage(getOwnerJid()!, { image: buffer, caption });
        else await sock.sendMessage(getOwnerJid()!, { video: buffer, caption });
    } catch (e) { log(`vv failed: ${e}`); }
}

async function handleSticker(msg: any, chatJid: string) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    if (!ctx?.quotedMessage) return;
    const media = ctx.quotedMessage.imageMessage || ctx.quotedMessage.videoMessage;
    if (!media || !ctx.quotedMessage.imageMessage) return sock.sendMessage(chatJid, { text: "❌ Reply to an image." });
    try {
        const buffer = await downloadMedia(media, "image");
        await sock.sendMessage(chatJid, { sticker: await sharp(buffer).webp().toBuffer() });
    } catch (e) { log(`Sticker failed: ${e}`); }
}

async function handleStatusReaction(msg: any) {
    const chatJid = msg.key.remoteJid || "";
    if (chatJid !== "status@broadcast" || isFromMe(msg)) return;
    const REACTIONS = ["❤️", "🔥", "🥰", "😍", "💯", "😘", "👏", "🙌", "🤗", "✨", "💖", "🌟"];
    const emoji = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
    try {
        await sock.sendMessage(chatJid, { react: { text: emoji, key: msg.key } });
        log(`[STATUS] Liked status with ${emoji}`); // 🔑 Debug log
    } catch (e) { log(`Status like failed: ${e}`); }
}

// ── Main Run ───────────────────────────────────────────────────────────
async function run() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) },
        browser: Browsers.ubuntu("Chrome"),
        printQRInTerminal: false,
        syncFullHistory: false,
        logger: pino({ level: "silent" }),
        markOnlineOnConnect: true, // 👈 ADD THIS LINE
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            if (PAIRING_PHONE && !pairingRequested && !state.creds.registered) {
                pairingRequested = true;
                try {
                    const cleanPhone = PAIRING_PHONE.replace(/\D/g, "");
                    const code = await sock.requestPairingCode(cleanPhone);
                    ipc({ type: "pairing", code });
                    log(`✅ Pairing code: ${code}`);
                } catch (e: any) {
                    ipc({ type: "pairing_error", error: e.message || "Unknown error" });
                    pairingRequested = false;
                }
            }
        }

        if (connection === "open") {
            pairingRequested = false;
            ipc({ type: "connected", phoneNumber: sock.user?.id?.split(":")[0] });
            log(`✅ Connected successfully`);
        }

        if (connection === "close") {
            if (stopping) return;
            const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
            if (pairingRequested && !state.creds.registered) return;
            if (code === DisconnectReason.loggedOut) { ipc({ type: "logged_out" }); return; }
            setTimeout(() => run().catch(() => { }), 3000);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }: any) => {
        for (const msg of messages) {
            if (!msg.message) continue;
            const chatJid = msg.key.remoteJid || "";
            const text = getText(msg);
            const cmd = text.trim().toLowerCase().replace(/^\./, "");
            const args = text.trim().split(/\s+/).slice(1);

            if (msg.message?.reactionMessage) { await handleReaction(msg); continue; }
            if (chatJid === "status@broadcast") { await handleStatusReaction(msg); continue; }

            if (autoTypingEnabled && !isFromMe(msg) && text) {
                try { await sock.sendPresenceUpdate("composing", chatJid); } catch { }
            }

            await handleViewOnce(msg, chatJid);

            // 🔑 SNAPPY DELETION: Delete commands immediately before processing
            if (cmd === "vv") {
                try { await sock.sendMessage(chatJid, { delete: msg.key }); } catch { }
                await handleVv(msg, chatJid);
            }
            if (cmd === "save") {
                try { await sock.sendMessage(chatJid, { delete: msg.key }); } catch { }
                await handleSaveStatus(msg, chatJid);
            }

            if (cmd === "ping") await sock.sendMessage(chatJid, { text: "🏓 Pong!" });
            if (cmd === "autotyping on") { autoTypingEnabled = true; await sock.sendMessage(chatJid, { text: "✍️ Auto-typing ON" }); }
            if (cmd === "presence off") {
                await sock.sendPresenceUpdate("unavailable").catch(() => { });
                await sock.sendMessage(chatJid, { text: "👻 Bot is now invisible (Offline)." });
            }
            if (cmd === "presence on") {
                await sock.sendPresenceUpdate("available").catch(() => { });
                await sock.sendMessage(chatJid, { text: "🟢 Bot is now visible (Online)." });
            }
            if (cmd === "autotyping off") { autoTypingEnabled = false; await sock.sendMessage(chatJid, { text: "🚫 Auto-typing OFF" }); }
            if (cmd === "savepp") await handleSavePP(msg, chatJid, args);
            if (cmd === "sticker") await handleSticker(msg, chatJid);

            if (cmd === "files") await sock.sendMessage(chatJid, { text: `📁 View all files: ${process.env.PUBLIC_URL}/my-files` });
            if (cmd === "menu") await sock.sendMessage(chatJid, { text: `🤖 *Menu*\nping\nfiles\nautotyping on/off\nsave\nvv\nsavepp\nsticker` });
        }
    });
}

// Keep process alive AND keep WhatsApp status as "Online"
const keepAlive = setInterval(() => {
    try {
        if (sock?.user) {
            sock.sendPresenceUpdate("available").catch(() => { });
        }
    } catch { }
}, 60_000);
process.on("message", (m: any) => { if (m?.type === "kill") { clearInterval(keepAlive); process.exit(0); } });
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
run().catch(e => { console.error(e); ipc({ type: "error", error: e.message }); });