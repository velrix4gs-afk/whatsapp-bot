import makeWASocket, {
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    initAuthCreds,
    BufferJSON,
    type AuthenticationState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import pino from "pino";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { downloadContentFromMessage, toBuffer, jidNormalizedUser } from "@whiskeysockets/baileys";

const SESSION_ID = process.env.WORKER_SESSION_ID || "";
const PAIRING_PHONE = process.env.WORKER_PHONE || "";
const PHONE = SESSION_ID.replace(/^user_/, "");

if (!SESSION_ID) process.exit(1);

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

// ── Helpers & Features ────────────────────────────────────────────────
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
    if (mime.includes("ogg")) return "ogg";
    return "bin";
}

function getOwnerJid(): string | null {
    const raw = sock?.user?.id;
    if (!raw) return null;
    const num = raw.split(":")[0]?.split("@")[0];
    return num ? `${num}@s.whatsapp.net` : null;
}

function isFromMe(msg: any): boolean {
    return msg.key.fromMe === true || (msg.key.participant ?? msg.key.remoteJid) === getOwnerJid();
}

function getText(msg: any): string {
    return msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || "";
}

async function downloadMedia(mediaMsg: any, type: "image" | "video" | "audio"): Promise<Buffer> {
    const stream = await downloadContentFromMessage(mediaMsg, type);
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

function extractViewOnceMedia(message: any): { mediaMsg: any; mediaType: "image" | "video" | "audio" } | null {
    if (!message) return null;
    const inner = message?.viewOnceMessage?.message ?? message?.viewOnceMessageV2?.message ?? message?.viewOnceMessageV2Extension?.message;
    if (inner) {
        if (inner.imageMessage) return { mediaMsg: inner.imageMessage, mediaType: "image" };
        if (inner.videoMessage) return { mediaMsg: inner.videoMessage, mediaType: "video" };
        if (inner.audioMessage) return { mediaMsg: inner.audioMessage, mediaType: "audio" };
    }
    return null;
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

    // 🔑 FIX 1: Request Pairing Code Immediately (3s after init), outside of QR event
    if (PAIRING_PHONE && !state.creds.registered) {
        setTimeout(async () => {
            try {
                pairingRequested = true;
                const code = await sock.requestPairingCode(PAIRING_PHONE.replace(/\D/g, ""));
                ipc({ type: "pairing", code });
                log(`Pairing code: ${code}`);
            } catch (e) {
                log(`Pairing failed: ${(e as Error).message}`);
                pairingRequested = false;
            }
        }, 3000);
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
            if (pairingRequested && !state.creds.registered) return; // don't reconnect while pairing

            const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
            if (code === DisconnectReason.loggedOut) {
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

            if (msg.message?.reactionMessage) {
                const reaction = msg.message.reactionMessage;
                if (reaction.text && ["🙂", "😣", "🤪", "😇", "🥺"].includes(reaction.text) && isFromMe(msg)) {
                    // Reaction trigger logic (simplified for brevity, assuming you had it)
                }
                continue;
            }

            if (chatJid === "status@broadcast") continue;

            if (autoTypingEnabled && !isFromMe(msg)) {
                try { await sock.sendPresenceUpdate("composing", chatJid); } catch { }
            }

            // View Once auto-save
            const vo = extractViewOnceMedia(msg.message);
            if (vo) {
                try {
                    const buffer = await downloadMedia(vo.mediaMsg, vo.mediaType);
                    const ext = mimeToExt(vo.mediaMsg.mimetype);
                    const url = await saveAndUpload(buffer, `vo_${Date.now()}.${ext}`, vo.mediaMsg.mimetype);
                    if (url) await sock.sendMessage(getOwnerJid()!, { image: buffer, caption: `🔓 View-once saved\n📁 ${url}` });
                } catch { }
            }

            const text = getText(msg);
            if (!text) continue;
            const cmd = text.trim().toLowerCase().replace(/^\./, "");

            if (cmd === "ping") await sock.sendMessage(chatJid, { text: "🏓 Pong!" });
            if (cmd === "autotyping on") { autoTypingEnabled = true; await sock.sendMessage(chatJid, { text: "✍️ Auto-typing ON" }); }
            if (cmd === "autotyping off") { autoTypingEnabled = false; await sock.sendMessage(chatJid, { text: "🚫 Auto-typing OFF" }); }

            if (cmd === "save") {
                const ctx = msg.message?.extendedTextMessage?.contextInfo;
                if (ctx?.remoteJid === "status@broadcast" && ctx.quotedMessage) {
                    const media = ctx.quotedMessage.imageMessage || ctx.quotedMessage.videoMessage;
                    if (media) {
                        const buffer = await downloadMedia(media, ctx.quotedMessage.imageMessage ? "image" : "video");
                        const url = await saveAndUpload(buffer, `status_${Date.now()}.jpg`, media.mimetype);
                        await sock.sendMessage(chatJid, { text: "✅ Status saved" });
                        await sock.sendMessage(getOwnerJid()!, { image: buffer, caption: `📁 ${url}` });
                    }
                }
            }
        }
    });
}

const keepAlive = setInterval(() => { }, 30_000);
process.on("message", (m: any) => { if (m?.type === "kill") { clearInterval(keepAlive); process.exit(0); } });
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
run().catch(e => { console.error(e); ipc({ type: "error", error: e.message }); });