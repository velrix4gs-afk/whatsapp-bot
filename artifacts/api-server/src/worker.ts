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
import { loadSettings, getActiveAiProvider, getPersona, getPersonaProvider, type BotSettings } from "./lib/settings";
import { callAiProvider, firstMatchingRule } from "./lib/ai";
import { getChatToggles, setChatToggle } from "./lib/chat-settings";
import { getActiveSession, startSession, appendToSession, endSession, isStopMessage } from "./lib/ai-sessions";
import { listAutoRules, matchAutoRule } from "./lib/auto-respond";

const SESSION_ID = process.env.WORKER_SESSION_ID || "";
const PAIRING_PHONE = process.env.WORKER_PHONE || "";
const PHONE = SESSION_ID.replace(/^user_/, "");

if (!SESSION_ID) process.exit(1);

const BASE_DIR = path.join(process.cwd(), "data");
const AUTH_DIR = path.join(BASE_DIR, "sessions", SESSION_ID, "auth");
const MEDIA_DIR = path.join(BASE_DIR, "sessions", SESSION_ID, "media");
fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

let supabase: ReturnType<typeof createClient> | null = null;
try {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
        supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { realtime: { transport: ws as any } });
    }
} catch (e) {
    console.error(`[${SESSION_ID}] Supabase init failed:`, e);
}

function ipc(msg: any) { try { if (process.send && process.connected) process.send(msg); } catch { } }
function log(text: string) { console.log(`[${SESSION_ID}] ${text}`); ipc({ type: "log", text }); }

let pairingRequested = false;
let sock: any = null;
let stopping = false;
let autoTypingEnabled = true;
let reconnectTimer: NodeJS.Timeout | null = null;
let generation = 0;

// ── Live settings (re-read from disk, lightly cached) ──────────────────
let cachedSettings: BotSettings | null = null;
let cachedAt = 0;
function settings(): BotSettings {
    if (!cachedSettings || Date.now() - cachedAt > 2000) {
        try { cachedSettings = loadSettings(); cachedAt = Date.now(); } catch { cachedSettings = cachedSettings ?? ({} as BotSettings); }
    }
    return cachedSettings as BotSettings;
}

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

/** The linked account's phone digits, used as the storage folder so /my-files matches. */
function storagePhone(): string {
    const raw = sock?.user?.id ?? "";
    const digits = raw.split(":")[0]?.split("@")[0] ?? "";
    return /^\d+$/.test(digits) ? digits : PHONE;
}

function isFromMe(msg: any): boolean {
    const ownerJid = getOwnerJid();
    if (!ownerJid) return false;
    const sender = msg.key.participant ?? msg.key.remoteJid ?? "";
    return sender === ownerJid || msg.key.fromMe === true;
}

/** Unwrap ephemeral / viewOnce envelopes to reach the real content. */
function unwrap(message: any): any {
    let cur = message;
    for (let i = 0; i < 4 && cur; i++) {
        if (cur.ephemeralMessage?.message) { cur = cur.ephemeralMessage.message; continue; }
        if (cur.viewOnceMessage?.message) { cur = cur.viewOnceMessage.message; continue; }
        if (cur.viewOnceMessageV2?.message) { cur = cur.viewOnceMessageV2.message; continue; }
        if (cur.viewOnceMessageV2Extension?.message) { cur = cur.viewOnceMessageV2Extension.message; continue; }
        break;
    }
    return cur;
}

function getText(msg: any): string {
    const m = unwrap(msg.message);
    if (!m) return "";
    return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || "";
}

type MediaMsg = { url?: string; directPath?: string; mediaKey?: unknown; mimetype?: string };

async function downloadMedia(mediaMsg: MediaMsg, mediaType: "image" | "video" | "audio"): Promise<Buffer> {
    const stream = await downloadContentFromMessage(mediaMsg as any, mediaType);
    return toBuffer(stream);
}

async function saveToSupabase(buffer: Buffer, filename: string, mime: string): Promise<boolean> {
    if (!supabase) { log("⚠️ Supabase not configured — saved to local only"); return false; }
    try {
        const storagePath = `${storagePhone()}/${filename}`;
        const { error } = await supabase.storage.from("saved_media").upload(storagePath, buffer, { contentType: mime, upsert: false });
        if (error) { log(`❌ Upload failed: ${error.message}`); return false; }
        return true;
    } catch (e) {
        log(`❌ Upload threw: ${e instanceof Error ? e.message : String(e)}`);
        return false;
    }
}

// ── Features ───────────────────────────────────────────────────────────
const viewOnceCache = new Map<string, { mediaMsg: MediaMsg; mediaType: "image" | "video" | "audio"; senderJid: string }>();

function extractViewOnceMedia(m: any): { media: MediaMsg; type: "image" | "video" | "audio" } | null {
    const c = unwrap(m);
    if (!c) return null;
    const inner = c.viewOnceMessage?.message ?? c.viewOnceMessageV2?.message ?? c.viewOnceMessageV2Extension?.message ?? c;
    if (inner?.imageMessage) return { media: inner.imageMessage, type: "image" };
    if (inner?.videoMessage) return { media: inner.videoMessage, type: "video" };
    if (inner?.audioMessage) return { media: inner.audioMessage, type: "audio" };
    // Bare view-once without a wrapper
    if (c?.imageMessage?.viewOnce) return { media: c.imageMessage, type: "image" };
    if (c?.videoMessage?.viewOnce) return { media: c.videoMessage, type: "video" };
    return null;
}

async function handleViewOnce(msg: any, chatJid: string) {
    if (!settings().features?.viewOnce) return;
    if (chatJid.endsWith("@g.us") || msg.key.fromMe) return; // personal chats only, never your own
    if (!getChatToggles(chatJid).vv) return;
    const extracted = extractViewOnceMedia(msg.message);
    if (!extracted) return;

    const ownerJid = getOwnerJid();
    if (!ownerJid) return;

    if (msg.key.id) viewOnceCache.set(msg.key.id, { mediaMsg: extracted.media, mediaType: extracted.type, senderJid: chatJid });

    try {
        const buffer = await downloadMedia(extracted.media, extracted.type);
        const ext = mimeToExt(extracted.media.mimetype);
        const success = await saveToSupabase(buffer, `vo_${Date.now()}.${ext}`, extracted.media.mimetype ?? "application/octet-stream");

        const webLink = `${process.env.PUBLIC_URL}/my-files`;
        const caption = `🔓 *View-once ${extracted.type}* (auto-saved)\nFrom: +${chatJid.split("@")[0]}\n\n📁 View all files: ${webLink}` + (success ? "" : "\n_⚠️ Cloud upload failed_");

        if (extracted.type === "image") await sock.sendMessage(ownerJid, { image: buffer, caption });
        else if (extracted.type === "video") await sock.sendMessage(ownerJid, { video: buffer, caption });
        else await sock.sendMessage(ownerJid, { audio: buffer, mimetype: extracted.media.mimetype, ptt: true });
    } catch (e) { log(`VO failed: ${e instanceof Error ? e.message : String(e)}`); }
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
        await saveToSupabase(buffer, `vo_react_${Date.now()}.${ext}`, cached.mediaMsg.mimetype ?? "application/octet-stream");

        const webLink = `${process.env.PUBLIC_URL}/my-files`;
        const caption = `🔓 *View-once ${cached.mediaType}* (via reaction)\nFrom: +${cached.senderJid.split("@")[0]}\n\n📁 View: ${webLink}`;

        const ownerJid = getOwnerJid()!;
        if (cached.mediaType === "image") await sock.sendMessage(ownerJid, { image: buffer, caption });
        else if (cached.mediaType === "video") await sock.sendMessage(ownerJid, { video: buffer, caption });
        else await sock.sendMessage(ownerJid, { audio: buffer, mimetype: cached.mediaMsg.mimetype, ptt: true });
    } catch (e) { log(`Reaction failed: ${e instanceof Error ? e.message : String(e)}`); }
}

async function handleSaveStatus(msg: any, chatJid: string) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    if (!ctx?.quotedMessage || ctx.remoteJid !== "status@broadcast") return;
    const q = unwrap(ctx.quotedMessage);
    const media = q.imageMessage || q.videoMessage || q.audioMessage;
    if (!media) return;

    try {
        const type = q.imageMessage ? "image" : q.videoMessage ? "video" : "audio";
        const buffer = await downloadMedia(media, type);
        const ext = mimeToExt(media.mimetype);
        await saveToSupabase(buffer, `status_${Date.now()}.${ext}`, media.mimetype ?? "application/octet-stream");

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
    } catch (e) { log(`Status save failed: ${e instanceof Error ? e.message : String(e)}`); }
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
    } catch (e) { log(`SavePP failed: ${e instanceof Error ? e.message : String(e)}`); }
}

async function handleVv(msg: any, chatJid: string) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    if (!ctx?.quotedMessage) return;
    const inner = unwrap(ctx.quotedMessage);
    const media = inner.imageMessage || inner.videoMessage;
    if (!media) return;
    try {
        const type = inner.imageMessage ? "image" : "video";
        const buffer = await downloadMedia(media, type);
        const ext = mimeToExt(media.mimetype);
        await saveToSupabase(buffer, `vv_${Date.now()}.${ext}`, media.mimetype ?? "application/octet-stream");

        const webLink = `${process.env.PUBLIC_URL}/my-files`;
        const caption = `🔓 *View-once ${type} (.vv)*\n\n📁 View: ${webLink}`;
        const ownerJid = getOwnerJid()!;
        if (type === "image") await sock.sendMessage(ownerJid, { image: buffer, caption });
        else await sock.sendMessage(ownerJid, { video: buffer, caption });
    } catch (e) { log(`vv failed: ${e instanceof Error ? e.message : String(e)}`); }
}

async function handleSticker(msg: any, chatJid: string) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    if (!ctx?.quotedMessage) return;
    const q = unwrap(ctx.quotedMessage);
    const media = q.imageMessage || q.videoMessage;
    if (!media || !q.imageMessage) return sock.sendMessage(chatJid, { text: "❌ Reply to an image." });
    try {
        const buffer = await downloadMedia(media, "image");
        await sock.sendMessage(chatJid, { sticker: await sharp(buffer).webp().toBuffer() });
    } catch (e) { log(`Sticker failed: ${e instanceof Error ? e.message : String(e)}`); }
}

async function handleStatusReaction(msg: any) {
    const chatJid = msg.key.remoteJid || "";
    if (chatJid !== "status@broadcast" || isFromMe(msg)) return;
    const s = settings();
    if (!s.features?.autoReact) return;
    const pool = s.reactionEmojis?.length ? s.reactionEmojis : ["❤️", "🔥", "💯"];
    const emoji = pool[Math.floor(Math.random() * pool.length)];
    try {
        await sock.sendMessage(chatJid, { react: { text: emoji, key: msg.key } });
    } catch (e) { log(`Status like failed: ${e instanceof Error ? e.message : String(e)}`); }
}

function buildMenu(chatJid: string): string {
    const t = getChatToggles(chatJid);
    const isGroup = chatJid.endsWith("@g.us");
    const on = (v: boolean) => (v ? "🟢 ON" : "🔴 OFF");
    return `╭━━━━━━━━━━━━━━━━╮
   🤖 *BOT MENU*
╰━━━━━━━━━━━━━━━━╯

*⚙️ THIS CHAT*
 ▸ /vv on|off — view-once save: ${isGroup ? "🚫 personal only" : on(t.vv)}
 ▸ /anticall on|off — reject calls: ${on(t.anticall)}
 ▸ /autoreply on|off — auto replies: ${on(t.autoreply)}

*🧠 AI*
 ▸ /ai <question> — ask the default AI
 ▸ /ai/<name> <question> — use a persona
 ▸ <name> <question> — call a persona by name
 ▸ say "enough" — end the persona chat

*🛠 TOOLS*
 ▸ /vv — save replied view-once
 ▸ /save — save replied status
 ▸ /savepp [number] — save profile picture
 ▸ /sticker — sticker from replied image
 ▸ /files — saved media
 ▸ /ping — bot status

_Powered by NovaBot_`;
}

const CUSTOM_CMDS_FILE = path.join(process.cwd(), "data", "custom-commands.json");

function findCustomCommand(text: string): { prefix: string; response: string } | null {
    try {
        if (!fs.existsSync(CUSTOM_CMDS_FILE)) return null;
        const cmds = JSON.parse(fs.readFileSync(CUSTOM_CMDS_FILE, "utf8"));
        if (!Array.isArray(cmds)) return null;
        const t = text.trim().toLowerCase();
        return cmds.find((c: any) =>
            typeof c?.prefix === "string" && c.prefix.trim() &&
            typeof c?.response === "string" && c.response &&
            t.startsWith(c.prefix.trim().toLowerCase())
        ) ?? null;
    } catch { return null; }
}

/** "Nora what is utc" → { persona: nora, question: "what is utc" } */
function matchPersonaPrefix(text: string): { persona: any; question: string } | null {
    const t = text.trim();
    for (const p of settings().personas ?? []) {
        if (!p?.name) continue;
        const esc = p.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const m = t.match(new RegExp(`^@?${esc}\\b[\\s,:;.!?-]*(.*)$`, "i"));
        if (m) return { persona: p, question: (m[1] || "").trim() };
    }
    return null;
}

// ── AI ────────────────────────────────────────────────────────────────
function senderDigits(msg: any): string {
    const raw = msg.key.participant ?? msg.key.remoteJid ?? "";
    return String(raw).split("@")[0].split(":")[0];
}

function isOwnerSender(msg: any): boolean {
    if (msg.key.fromMe) return true;
    const admin = (settings().adminNumber || "").replace(/\D/g, "");
    return !!admin && senderDigits(msg) === admin;
}

async function handleAiQuestion(chatJid: string, question: string, personaName?: string, join = false) {
    const s = settings();
    const persona = personaName ? getPersona(s, personaName) : null;
    const provider = getPersonaProvider(s, persona);
    if (!provider) {
        await sock.sendMessage(chatJid, { text: "⚠️ No AI provider configured. Add one in the admin panel." });
        return;
    }
    const base = persona?.instructions || s.aiSystemPrompt;
    const systemPrompt = join
        ? `${base}\n\nYou have just joined a WhatsApp conversation. Reply briefly and naturally. The user will say "enough" or "stop" when they want you to leave.`
        : base;
    if (join && persona) startSession(chatJid, persona.name);
    try {
        await sock.sendPresenceUpdate("composing", chatJid).catch(() => { });
        const existing = join ? null : getActiveSession(chatJid);
        const history = existing && persona &&
            existing.persona.trim().toLowerCase() === persona.name.trim().toLowerCase()
            ? existing.history : [];
        const reply = await callAiProvider(provider, question, systemPrompt, history);
        await sock.sendMessage(chatJid, { text: reply || "🤖 (empty response)" });
        if (join) {
            appendToSession(chatJid, { role: "user", content: question });
            appendToSession(chatJid, { role: "assistant", content: reply });
        }
    } catch (e) {
        await sock.sendMessage(chatJid, { text: `❌ AI error: ${e instanceof Error ? e.message : String(e)}` });
    }
}

/** Reply inside an ongoing persona conversation (started by calling the persona's name). */
async function handleSessionReply(chatJid: string, text: string, msg: any): Promise<boolean> {
    const active = getActiveSession(chatJid);
    if (!active) return false;
    const s = settings();
    const persona = getPersona(s, active.persona);
    const provider = getPersonaProvider(s, persona);
    if (!provider) {
        endSession(chatJid);
        await sock.sendMessage(chatJid, { text: `⚠️ ${active.persona} left — no AI provider configured.` });
        return true;
    }
    const base = persona?.instructions || s.aiSystemPrompt;
    const systemPrompt = `${base}\n\nYou are in an ongoing WhatsApp conversation. Reply naturally and briefly. The user will say "enough" or "stop" when they want you to leave.`;
    const history = active.history.slice();
    appendToSession(chatJid, { role: "user", content: text });
    try {
        await sock.sendPresenceUpdate("composing", chatJid).catch(() => { });
        const reply = await callAiProvider(provider, text, systemPrompt, history);
        if (reply) {
            await sock.sendMessage(chatJid, { text: reply }, { quoted: msg });
            appendToSession(chatJid, { role: "assistant", content: reply });
        }
        return true;
    } catch (e) {
        log(`AI session error: ${e instanceof Error ? e.message : String(e)}`);
        return true;
    }
}

/** Reproduce a saved per-contact auto-respond rule. Returns true when it replied. */
async function maybeAutoRespond(msg: any, chatJid: string, text: string): Promise<boolean> {
    const s = settings();
    if (!s.features?.aiChat) return false;
    if (msg.key.fromMe || chatJid.endsWith("@g.us")) return false;
    if (!getChatToggles(chatJid).autoreply) return false;

    const rule = matchAutoRule(listAutoRules(), senderDigits(msg), text);
    if (!rule) return false;

    try {
        await sock.sendPresenceUpdate("composing", chatJid).catch(() => { });
        let replyText = (rule.reply || "").replace(/\{name\}/g, msg.pushName || "there");
        if (rule.instructions) {
            const provider = getPersonaProvider(s, { id: rule.id, name: "auto-respond", instructions: rule.instructions });
            if (provider) {
                try {
                    const ai = await callAiProvider(provider, text, rule.instructions);
                    if (ai) replyText = ai;
                } catch (e) { log(`Auto-respond AI failed, using canned reply: ${e instanceof Error ? e.message : String(e)}`); }
            }
        }
        if (replyText) await sock.sendMessage(chatJid, { text: replyText }, { quoted: msg });
        return true;
    } catch (e) {
        log(`Auto-respond failed: ${e instanceof Error ? e.message : String(e)}`);
        return true;
    }
}

async function maybeAiReply(msg: any, chatJid: string, text: string) {
    const s = settings();
    if (!s.features?.aiChat || !text.trim()) return;
    if (msg.key.fromMe) return; // never answer your own outgoing messages
    if (!getChatToggles(chatJid).autoreply) return;

    const isGroup = chatJid.endsWith("@g.us");
    const admin = (s.adminNumber || "").replace(/\D/g, "");
    const from = senderDigits(msg);

    if (s.features.replyMode === "only" && admin && from !== admin) return;

    // In groups, only answer when mentioned, to avoid replying to every message.
    if (isGroup) {
        const mentioned = !!msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length;
        const directInvite = /^(ai|bot)[,:\s]/i.test(text.trim());
        if (!mentioned && !directInvite && s.features.replyMode !== "all") return;
    }

    const rule = firstMatchingRule(s.aiRules, text);
    if (rule) {
        try { await sock.sendMessage(chatJid, { text: rule.response }, { quoted: msg }); } catch (e) { log(`rule reply failed: ${e}`); }
        return;
    }

    const provider = getActiveAiProvider(s);
    if (!provider) return;

    try {
        await sock.sendPresenceUpdate("composing", chatJid).catch(() => { });
        const reply = await callAiProvider(provider, text, s.aiSystemPrompt);
        if (reply) await sock.sendMessage(chatJid, { text: reply }, { quoted: msg });
    } catch (e) {
        log(`AI error: ${e instanceof Error ? e.message : String(e)}`);
    }
}

// ── Main Run ───────────────────────────────────────────────────────────
async function getBaileysVersion(): Promise<any> {
    try {
        const res = await Promise.race([
            fetchLatestBaileysVersion(),
            new Promise<null>((r) => setTimeout(() => r(null), 5000)),
        ]);
        return res ? res.version : undefined;
    } catch { return undefined; }
}

async function run() {
    const myGen = ++generation;
    ipc({ type: "started" });

    // Tear down any previous socket so reconnects don't leak sessions/listeners.
    if (sock) {
        try { sock.ev.removeAllListeners("connection.update"); } catch { }
        try { sock.ev.removeAllListeners("messages.upsert"); } catch { }
        try { sock.end(undefined); } catch { }
        sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const version = await getBaileysVersion();

    const socket = makeWASocket({
        version,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) },
        browser: Browsers.ubuntu("Chrome"),
        printQRInTerminal: false,
        syncFullHistory: false,
        logger: pino({ level: "silent" }),
        markOnlineOnConnect: true,
    });
    sock = socket;

    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", async (update: any) => {
        if (myGen !== generation) return;
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            ipc({ type: "qr", qr });
            if (PAIRING_PHONE && !pairingRequested && !state.creds.registered) {
                pairingRequested = true;
                try {
                    const cleanPhone = PAIRING_PHONE.replace(/\D/g, "");
                    const code = await socket.requestPairingCode(cleanPhone);
                    ipc({ type: "pairing", code });
                    log(`✅ Pairing code: ${code}`);
                } catch (e: any) {
                    ipc({ type: "pairing_error", error: e?.message || "Unknown error" });
                    pairingRequested = false;
                }
            }
        }

        if (connection === "open") {
            pairingRequested = false;
            ipc({ type: "connected", phoneNumber: socket.user?.id?.split(":")[0] });
            log("✅ Connected successfully");
        }

        if (connection === "close") {
            if (stopping || myGen !== generation) return;
            const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
            if (code === DisconnectReason.loggedOut) {
                ipc({ type: "logged_out" });
                log("🚪 Logged out");
                process.exit(0);
            }
            if (pairingRequested && !state.creds.registered) return;
            if (reconnectTimer) return;
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                if (stopping) return;
                run().catch((e) => { log(`Reconnect failed: ${e}`); });
            }, 3000);
        }
    });

    socket.ev.on("call", async (calls: any[]) => {
        if (myGen !== generation) return;
        for (const call of calls) {
            if (call.status !== "offer") continue;
            const jid = call.chatId || call.from;
            if (!jid || !getChatToggles(jid).anticall) continue;
            try {
                await socket.rejectCall(call.id, call.from);
                log(`📵 Rejected call from ${jid}`);
            } catch (e) { log(`Call reject failed: ${e instanceof Error ? e.message : String(e)}`); }
        }
    });

    socket.ev.on("messages.upsert", async ({ messages }: any) => {
        if (myGen !== generation) return;
        for (const msg of messages) {
            if (!msg.message) continue;
            const chatJid = msg.key.remoteJid || "";
            const text = getText(msg);
            const rawCmd = text.trim().replace(/^[.!/]/, "");
            const parts = rawCmd.split(/\s+/);
            const cmd = (parts[0] || "").toLowerCase();
            const norm = rawCmd.toLowerCase();
            const args = parts.slice(1);

            if (msg.message?.reactionMessage) { await handleReaction(msg); continue; }
            if (chatJid === "status@broadcast") { await handleStatusReaction(msg); continue; }

            const s = settings();
            if (autoTypingEnabled && s.features?.autoPresence && !isFromMe(msg) && text) {
                try { await socket.sendPresenceUpdate("composing", chatJid); } catch { }
            }

            await handleViewOnce(msg, chatJid);

            let handled = false;
            const owner = isOwnerSender(msg);

            // Per-chat toggles (owner only)
            if (cmd === "vv" || cmd === "anticall" || cmd === "autoreply") {
                const value = (args[0] || "").toLowerCase();
                if (value === "on" || value === "off") {
                    handled = true;
                    const label = cmd === "vv" ? "View-once auto-save" : cmd === "anticall" ? "Anti-call" : "Auto-reply";
                    if (!owner) {
                        await socket.sendMessage(chatJid, { text: "🔒 Only the bot owner can change chat settings." });
                    } else if (cmd === "vv" && chatJid.endsWith("@g.us")) {
                        await socket.sendMessage(chatJid, { text: "🚫 View-once auto-save is personal-chat only." });
                    } else {
                        const key = cmd as "vv" | "anticall" | "autoreply";
                        const st = setChatToggle(chatJid, key, value === "on");
                        await socket.sendMessage(chatJid, { text: `${st[key] ? "✅" : "🚫"} ${label} ${st[key] ? "ON" : "OFF"} in this chat` });
                    }
                }
            }
            if (!handled && cmd === "vv") { handled = true; try { await socket.sendMessage(chatJid, { delete: msg.key }); } catch { } await handleVv(msg, chatJid); }
            if (cmd === "save") { handled = true; try { await socket.sendMessage(chatJid, { delete: msg.key }); } catch { } await handleSaveStatus(msg, chatJid); }
            if (cmd === "ping") { handled = true; await socket.sendMessage(chatJid, { text: "🏓 Pong!" }); }
            if (cmd === "menu" || cmd === "help") { handled = true; await socket.sendMessage(chatJid, { text: buildMenu(chatJid) }); }
            if (cmd === "files") { handled = true; await socket.sendMessage(chatJid, { text: `📁 View all files: ${process.env.PUBLIC_URL}/my-files` }); }
            if (cmd === "ai" || cmd.startsWith("ai/")) {
                handled = true;
                const question = args.join(" ").trim();
                if (!question) {
                    await socket.sendMessage(chatJid, { text: "Usage: /ai <question> or /ai/<name> <question>" });
                } else if (!owner && settings().features.replyMode === "only") {
                    await socket.sendMessage(chatJid, { text: "🔒 AI is limited to the admin in this mode." });
                } else {
                    await handleAiQuestion(chatJid, question, cmd.startsWith("ai/") ? cmd.slice(3) : undefined);
                }
            }
            // Persona by name: "Nora what is utc" / "nora, are you there"
            if (!handled && text.trim()) {
                const pm = matchPersonaPrefix(text);
                if (pm) {
                    handled = true;
                    if (!owner && settings().features.replyMode === "only") {
                        await socket.sendMessage(chatJid, { text: "🔒 AI is limited to the admin in this mode." });
                    } else if (!pm.question) {
                        startSession(chatJid, pm.persona.name);
                        await socket.sendMessage(chatJid, { text: `🤖 ${pm.persona.name} has joined the chat — ask away. Say "enough" when you're done.` });
                    } else {
                        await handleAiQuestion(chatJid, pm.question, pm.persona.name, true);
                    }
                }
            }
            // Ongoing persona conversation — reply until the user says enough/stop
            if (!handled && text.trim()) {
                const active = getActiveSession(chatJid);
                if (active) {
                    handled = true;
                    if (isStopMessage(text, active.persona)) {
                        endSession(chatJid);
                        await socket.sendMessage(chatJid, { text: `👋 ${active.persona} has left the conversation.` });
                    } else {
                        await handleSessionReply(chatJid, text, msg);
                    }
                }
            }
            // Custom commands (data/custom-commands.json)
            if (!handled && text.trim()) {
                const cc = findCustomCommand(text);
                if (cc) {
                    handled = true;
                    await socket.sendMessage(chatJid, {
                        text: cc.response
                            .replace(/\{time\}/g, new Date().toUTCString())
                            .replace(/\{name\}/g, msg.pushName || "there"),
                    });
                }
            }
            if (norm === "autotyping on" || norm === "autotyping off") {
                handled = true;
                if (!owner) { await socket.sendMessage(chatJid, { text: "🔒 Only the bot owner can change this." }); }
                else {
                    autoTypingEnabled = norm.endsWith("on");
                    await socket.sendMessage(chatJid, { text: `✍️ Auto-typing ${autoTypingEnabled ? "ON" : "OFF"}` });
                }
            }
            if (norm === "presence on" || norm === "presence off") {
                handled = true;
                if (!owner) { await socket.sendMessage(chatJid, { text: "🔒 Only the bot owner can change this." }); }
                else if (norm === "presence on") { await socket.sendPresenceUpdate("available").catch(() => { }); await socket.sendMessage(chatJid, { text: "🟢 Bot is now visible." }); }
                else { await socket.sendPresenceUpdate("unavailable").catch(() => { }); await socket.sendMessage(chatJid, { text: "👻 Bot is now invisible." }); }
            }
            if (cmd === "savepp") { handled = true; await handleSavePP(msg, chatJid, args); }
            if (cmd === "sticker" || cmd === "s") { handled = true; await handleSticker(msg, chatJid); }

            if (!handled && text.trim()) {
                const replied = await maybeAutoRespond(msg, chatJid, text).catch(() => false);
                if (!replied) {
                    try { await maybeAiReply(msg, chatJid, text); } catch (e) { log(`AI wrapper failed: ${e}`); }
                }
            }
        }
    });
}

// Keep process alive AND keep WhatsApp status as "Online"
const keepAlive = setInterval(() => {
    try {
        const s = settings();
        if (sock?.user && s.features?.autoPresence !== false) {
            sock.sendPresenceUpdate("available").catch(() => { });
        }
    } catch { }
}, 60_000);

process.on("message", (m: any) => { if (m?.type === "kill") { stopping = true; clearInterval(keepAlive); if (reconnectTimer) clearTimeout(reconnectTimer); process.exit(0); } });
process.on("SIGTERM", () => { stopping = true; process.exit(0); });
process.on("SIGINT", () => { stopping = true; process.exit(0); });

run().catch(e => { console.error(e); ipc({ type: "error", error: e instanceof Error ? e.message : String(e) }); });
