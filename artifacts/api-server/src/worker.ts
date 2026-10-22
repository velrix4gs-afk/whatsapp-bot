import makeWASocket, {
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    initAuthCreds,
    BufferJSON,
    downloadContentFromMessage,
    toBuffer,
    jidNormalizedUser,
    type AuthenticationState,
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
const MEDIA_DIR = path.join(BASE_DIR, "sessions", SESSION_ID, "media");
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    { realtime: { transport: ws as any } }
);

// ── Supabase Auth State ──────────────────────────────────────────────
async function useSupabaseAuthState(sessionId: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
    const readData = async (key: string) => {
        const { data } = await supabase.from("baileys_auth").select("data").eq("id", `${sessionId}_${key}`).maybeSingle();
        if (data && data.data) return JSON.parse(JSON.stringify(data.data), BufferJSON.reviver);
        return null;
    };

    const writeData = async (key: string, data: any) => {
        const serialized = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await supabase.from("baileys_auth").upsert({ id: `${sessionId}_${key}`, data: serialized });
    };

    const removeData = async (key: string) => {
        await supabase.from("baileys_auth").delete().eq("id", `${sessionId}_${key}`);
    };

    const creds = (await readData("creds")) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data: any = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === "app-state-sync-key" && value) {
                            value = require("@whiskeysockets/baileys").proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks: Promise<void>[] = [];
                    for (const category in data) {
                        for (const id in data[category as keyof typeof data]) {
                            const value = data[category as keyof typeof data]![id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(key, value) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: () => writeData("creds", creds),
    };
}

// ── Helpers ───────────────────────────────────────────────────────────
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

async function saveAndUpload(buffer: Buffer, filename: string, mime: string): Promise<string | null> {
    try {
        const storagePath = `${PHONE}/${filename}`;
        const { error } = await supabase.storage.from("saved_media").upload(storagePath, buffer, { contentType: mime, upsert: false });
        if (error) return null;
        return supabase.storage.from("saved_media").getPublicUrl(storagePath).data?.publicUrl ?? null;
    } catch { return null; }
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

    if (!media) return;
    const ownerJid = getOwnerJid();
    if (!ownerJid) return;

    if (msg.key.id) viewOnceCache.set(msg.key.id, { mediaMsg: media, mediaType: type, senderJid: chatJid });

    try {
        const buffer = await downloadMedia(media, type);
        const url = await saveAndUpload(buffer, `vo_${Date.now()}.${mimeToExt(media.mimetype)}`, media.mimetype);
        await sock.sendMessage(ownerJid, { [type]: buffer, caption: `🔓 View-once saved\n📁 ${url || 'Failed upload'}` });
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
        const url = await saveAndUpload(buffer, `vo_react_${Date.now()}.${mimeToExt(cached.mediaMsg.mimetype)}`, cached.mediaMsg.mimetype);
        await sock.sendMessage(getOwnerJid()!, { [cached.mediaType]: buffer, caption: `🔓 View-once saved via reaction\n📁 ${url}` });
    } catch (e) { log(`Reaction failed: ${e}`); }
}

async function handleSaveStatus(msg: any, chatJid: string) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    if (!ctx?.quotedMessage || ctx.remoteJid !== "status@broadcast") return;
    const media = ctx.quotedMessage.imageMessage || ctx.quotedMessage.videoMessage;
    if (!media) return;

    try {
        const type = ctx.quotedMessage.imageMessage ? "image" : "video";
        const buffer = await downloadMedia(media, type);
        const url = await saveAndUpload(buffer, `status_${Date.now()}.${mimeToExt(media.mimetype)}`, media.mimetype);

        await sock.sendMessage(chatJid, { text: "✅ Status saved" });
        await sock.sendMessage(getOwnerJid()!, { [type]: buffer, caption: `📁 ${url}` });
    } catch (e) { log(`Status save failed: ${e}`); }
}

async function handleSavePP(msg: any, chatJid: string, args: string[]) {
    let targetJid = args[0] ? `${args[0].replace(/\D/g, "")}@s.whatsapp.net` : (msg.key.participant ?? msg.key.remoteJid);
    try {
        const pp = await sock.profilePictureUrl(targetJid, "image");
        if (!pp) return sock.sendMessage(chatJid, { text: "❌ No profile picture." });
        const buffer = Buffer.from(await (await fetch(pp)).arrayBuffer());
        const url = await saveAndUpload(buffer, `pp_${Date.now()}.jpg`, "image/jpeg");
        await sock.sendMessage(chatJid, { text: `✅ Profile pic saved\n📁 ${url}` });
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
        const url = await saveAndUpload(buffer, `vv_${Date.now()}.${mimeToExt(media.mimetype)}`, media.mimetype);
        await sock.sendMessage(getOwnerJid()!, { [type]: buffer, caption: `🔓 Saved via .vv\n📁 ${url}` });
    } catch (e) { log(`vv failed: ${e}`); }
}

async function handleSticker(msg: any, chatJid: string) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    if (!ctx?.quotedMessage) return;
    const media = ctx.quotedMessage.imageMessage || ctx.quotedMessage.videoMessage;
    if (!media || !ctx.quotedMessage.imageMessage) return sock.sendMessage(chatJid, { text: "❌ Send an image." });
    try {
        const buffer = await downloadMedia(media, "image");
        await sock.sendMessage(chatJid, { sticker: await sharp(buffer).webp().toBuffer() });
    } catch (e) { log(`Sticker failed: ${e}`); }
}

// ── Main Run ───────────────────────────────────────────────────────────
async function run() {
    const { state, saveCreds } = await useSupabaseAuthState(SESSION_ID);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) },
        browser: Browsers.ubuntu("Chrome"),
        printQRInTerminal: false,
        syncFullHistory: false,
        logger: pino({ level: "silent" }),
    });

    sock.ev.on("creds.update", saveCreds);

    // 🔑 FIX: Request pairing code immediately after socket init, outside connection.update
    if (PAIRING_PHONE && !state.creds.registered) {
        setTimeout(async () => {
            try {
                pairingRequested = true;
                const code = await sock.requestPairingCode(PAIRING_PHONE.replace(/\D/g, ""));
                ipc({ type: "pairing", code });
                log(`Pairing code: ${code}`);
            } catch (e) {
                log(`Pairing failed: ${(e as Error).message}`);
                ipc({ type: "pairing_error", error: (e as Error).message });
                pairingRequested = false;
            }
        }, 3000); // Give it 3 seconds to fully connect before asking for code
    }

    sock.ev.on("connection.update", async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        // Only send QR if we didn't request a pairing code
        if (qr && !PAIRING_PHONE) ipc({ type: "qr", qr });

        if (connection === "open") {
            ipc({ type: "connected", phoneNumber: sock.user?.id?.split(":")[0] });
            log(`✅ Connected`);
        }

        if (connection === "close") {
            if (stopping) return;
            if (pairingRequested && !state.creds.registered) return;
            const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
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
            if (chatJid === "status@broadcast") continue;

            if (autoTypingEnabled && !isFromMe(msg)) {
                try { await sock.sendPresenceUpdate("composing", chatJid); } catch { }
            }

            await handleViewOnce(msg, chatJid);

            if (cmd === "ping") await sock.sendMessage(chatJid, { text: "🏓 Pong!" });
            if (cmd === "autotyping on") { autoTypingEnabled = true; await sock.sendMessage(chatJid, { text: "✍️ Auto-typing ON" }); }
            if (cmd === "autotyping off") { autoTypingEnabled = false; await sock.sendMessage(chatJid, { text: "🚫 Auto-typing OFF" }); }
            if (cmd === "save") await handleSaveStatus(msg, chatJid);
            if (cmd === "savepp") await handleSavePP(msg, chatJid, args);
            if (cmd === "vv") await handleVv(msg, chatJid);
            if (cmd === "sticker") await handleSticker(msg, chatJid);

            if (cmd === "files") {
                await sock.sendMessage(chatJid, { text: `📁 Login at: ${process.env.PUBLIC_URL}/my-files` });
            }

            if (cmd === "menu") {
                await sock.sendMessage(chatJid, { text: `🤖 *Menu*\nping\nfiles\nautotyping on/off\nsave\nvv\nsavepp\nsticker` });
            }
        }
    });
}

const keepAlive = setInterval(() => { }, 30_000);
process.on("message", (m: any) => { if (m?.type === "kill") { clearInterval(keepAlive); process.exit(0); } });
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
run().catch(e => { console.error(e); ipc({ type: "error", error: e.message }); });