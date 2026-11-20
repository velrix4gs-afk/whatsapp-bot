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
import { loadSettings, getPersona, getPersonaProvider, type BotSettings } from "./lib/settings";
import { callAiWithPool, firstMatchingRule, trimReply, isFillerReply } from "./lib/ai";
import { getChatToggles, setChatToggle } from "./lib/chat-settings";
import { getActiveSession, startSession, appendToSession, endSession, isStopMessage, setSessionScope } from "./lib/ai-sessions";
import { listAutoRules, matchAutoRule } from "./lib/auto-respond";
import { appendTurn, getMemory, learnIfNeeded, memoryPromptBlock } from "./lib/memory";

const SESSION_ID = process.env.WORKER_SESSION_ID || "";
const PAIRING_PHONE = process.env.WORKER_PHONE || "";
const PHONE = SESSION_ID.replace(/^user_/, "");

if (!SESSION_ID) process.exit(1);
setSessionScope(SESSION_ID);

const BASE_DIR = path.join(process.cwd(), "data");
const AUTH_DIR = path.join(BASE_DIR, "sessions", SESSION_ID, "auth");
const MEDIA_DIR = path.join(BASE_DIR, "sessions", SESSION_ID, "media");
fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

/** A failed pairing leaves half-written keys behind that block every retry. */
function wipeAuthDir() {
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch { }
    try { fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch { }
}

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

        const webLink = `${publicLink()}/my-files`;
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

        const webLink = `${publicLink()}/my-files`;
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
            const webLink = `${publicLink()}/my-files`;
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

        const webLink = `${publicLink()}/my-files`;
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

        const webLink = `${publicLink()}/my-files`;
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

    // Mark the status as viewed so the poster sees the blue tick, even when the
    // reaction itself fails (reactions alone don't always register a view).
    try { await sock.readMessages([msg.key]); } catch { /* older Baileys builds */ }
    try { await sock.sendPresenceUpdate("available", "status@broadcast"); } catch { }

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
 ▸ ai — call me into this chat
 ▸ ai <question> — ask me
 ▸ <name> / @<name> — call a persona
 ▸ say "enough" — I go quiet

*⌨️ CUSTOM COMMANDS*
 ▸ /commands — list this bot's commands
 ▸ create them in the admin panel → Settings

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

function customCommandList(): string {
    try {
        const cmds = fs.existsSync(CUSTOM_CMDS_FILE) ? JSON.parse(fs.readFileSync(CUSTOM_CMDS_FILE, "utf8")) : [];
        if (!Array.isArray(cmds) || !cmds.length) {
            return "⌨️ *Custom commands*\n\nNone yet. Create one in the admin panel → Settings → Custom commands.\nExample: trigger `.price`, reply \"Our plans start at 5k\".";
        }
        const lines = cmds
            .filter((c: any) => c?.prefix && c?.response)
            .map((c: any) => ` ▸ ${c.prefix}${c.description ? ` — ${c.description}` : ""}`);
        return `⌨️ *Custom commands*\n\n${lines.join("\n")}\n\nType any of them to get the reply.`;
    } catch {
        return "⌨️ No custom commands yet.";
    }
}

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

/** Public web link for this deployment (used when people ask how to link their bot). */
function publicLink(): string {
    const s = settings();
    const raw = (s.publicUrl !== undefined ? s.publicUrl : process.env.PUBLIC_URL) ?? "";
    return String(raw).trim().replace(/\/+$/, "");
}

// Lightweight activity log so the AI can honestly answer "is Velrix online?"
const SEEN_FILE = path.join(BASE_DIR, "sessions", SESSION_ID, "last-seen.json");
function recordSeen(digits: string): void {
    if (!digits) return;
    try {
        const file = SEEN_FILE;
        let seen: Record<string, number> = {};
        try { seen = JSON.parse(fs.readFileSync(file, "utf8")); } catch { }
        seen[digits] = Date.now();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(seen));
    } catch { /* ignore */ }
}
function lastSeenMinutesAgo(digits: string): number | null {
    try {
        const seen = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")) as Record<string, number>;
        const t = seen[digits];
        return t ? Math.max(0, Math.round((Date.now() - t) / 60_000)) : null;
    } catch { return null; }
}

/** Facts about this deployment injected into every AI prompt. */
function deploymentContext(): string {
    const s = settings();
    const link = publicLink();
    const admin = (s.adminNumber || "").replace(/\D/g, "");
    const last = admin ? lastSeenMinutesAgo(admin) : null;
    const activity = last === null
        ? ""
        : last <= 5
            ? "Owner activity: the owner looks ONLINE right now (account active less than 5 minutes ago)."
            : `Owner activity: owner last active on this account ${last} minute(s) ago.`;
    const lines = [
        "You are the assistant on this WhatsApp account. Talk like a real human texting.",
        link ? `Link page URL: exactly ${link}/link` : "",
        link ? `If someone asks for the link to link their bot, send exactly that URL — never invent a whatsapp.com or other link.` : "",
        link ? `Saved files page: ${link}/my-files` : "",
        admin ? `Owner/admin: +${admin}.` : "",
        activity,
        activity
            ? "If asked whether the owner is online, answer from the owner activity line only."
            : "If asked whether the owner is online, say you can't confirm right now — never guess.",
    ];
    return "\n\n[Deployment info]\n" + lines.filter(Boolean).join("\n");
}

/** Deterministic answer for "how do I link my bot" — models are unreliable here. */
const LINK_INTENT = /\b(link|connect|register|sign\s*up)\b.*\b(bot|whatsapp|number|account)\b|\b(link|connect)\b.*\bmy\b.*\b(bot|whatsapp)\b|\bwhere\b.*\b(link|connect)\b/i;
async function maybeLinkAnswer(chatJid: string, text: string): Promise<boolean> {
    const link = publicLink();
    if (!link) return false;
    if (!LINK_INTENT.test(text)) return false;
    await sock.sendMessage(chatJid, { text: `🔗 Link your bot here: ${link}/link\n\nOpen it, enter your number and scan the QR code.` });
    return true;
}

/** Text of the message the user quoted/replied to, if any. */
function quotedSnippet(msg: any): string {
    const q = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!q) return "";
    const inner = unwrap(q);
    const t = inner?.conversation || inner?.extendedTextMessage?.text ||
        inner?.imageMessage?.caption || inner?.videoMessage?.caption || "";
    return String(t).slice(0, 300);
}

/** Prefix the user's text with the quoted message so the model knows what it's replying to. */
function withQuote(msg: any, text: string): string {
    const q = quotedSnippet(msg);
    return q ? `(replying to: "${q}")\n${text}` : text;
}

const DEFAULT_PERSONA = "Nova";
const ARRIVALS = ["I'm here 😎 what's up?", "I'm in 👋 what's going on?", "made it 😄 talk to me", "here — what's good?"];

function arrivalLine(personaName?: string): string {
    const line = ARRIVALS[Math.floor(Math.random() * ARRIVALS.length)];
    return personaName ? `${personaName}: ${line}` : line;
}

/** One AI turn with short-reply styling, contact memory and failover pool. */
async function aiTurn(
    chatJid: string,
    contact: string,
    text: string,
    systemPrompt: string,
    history: { role: "user" | "assistant"; content: string }[],
    preferredProviderId?: string,
    pushName?: string
): Promise<string> {
    const s = settings();
    // Groups never see per-contact memory: facts learned in a DM must not
    // surface in an unrelated group (and vice versa).
    const useMemory = !chatJid.endsWith("@g.us");
    let prompt = systemPrompt + deploymentContext();
    let turns = history.slice(-12);

    if (useMemory) {
        try {
            const mem = await getMemory(SESSION_ID, contact);
            if (!turns.length) {
                // No live session: continue from this contact's recent chat history.
                const recent = mem.recent.slice(-10).map(t => ({ role: t.role, content: t.text }));
                const last = recent[recent.length - 1];
                if (last && last.role === "user" && last.content.trim() === text.trim()) recent.pop();
                turns = recent;
            }
            prompt += memoryPromptBlock(mem, pushName);
        } catch { /* memory is best-effort */ }
    }

    await sock.sendPresenceUpdate("composing", chatJid).catch(() => { });
    const { text: reply } = await callAiWithPool(s, text, prompt, turns, { preferredId: preferredProviderId });
    const trimmed = trimReply(reply);
    // Never send canned assistant filler ("I'm here to help…") into a chat.
    if (!trimmed || isFillerReply(trimmed)) return "";
    return trimmed;
}

/**
 * Record the bot's reply (inbound text is recorded in the message listener) and
 * every few messages fold the recent exchange into the contact's memory.
 */
function rememberExchange(contact: string, _userText: string, replyText: string, pushName?: string): void {
    void appendTurn(SESSION_ID, contact, "assistant", replyText)
        .then(() => learnIfNeeded(SESSION_ID, contact, pushName, settings()))
        .catch(() => { /* ignore */ });
}

async function handleAiQuestion(chatJid: string, question: string, personaName?: string, join = false, msg?: any) {
    const s = settings();
    if (await maybeLinkAnswer(chatJid, question)) return;
    const persona = personaName ? getPersona(s, personaName) : null;
    const preferred = getPersonaProvider(s, persona);
    if (!preferred) {
        await sock.sendMessage(chatJid, { text: "⚠️ No AI provider configured. Add one in the admin panel." });
        return;
    }
    const contact = msg ? senderDigits(msg) : chatJid.split("@")[0].split(":")[0];
    const base = persona?.instructions || s.aiSystemPrompt;
    const systemPrompt = join
        ? `${base}\n\nYou are ${persona?.name ?? DEFAULT_PERSONA}, a real person texting in this WhatsApp chat — casual, funny, you flow with the conversation. Keep every reply to 1-2 short sentences. You were called in; when the user says "enough" or "stop" you leave.`
        : base;
    if (join && persona) startSession(chatJid, persona.name);
    try {
        const existing = join ? null : getActiveSession(chatJid);
        const history = existing && persona &&
            existing.persona.trim().toLowerCase() === persona.name.trim().toLowerCase()
            ? existing.history : [];
        const contextText = msg ? withQuote(msg, question) : question;
        const reply = await aiTurn(chatJid, contact, contextText, systemPrompt, history, preferred?.id, msg?.pushName);
        if (reply) await sock.sendMessage(chatJid, { text: reply });
        if (join && reply) {
            appendToSession(chatJid, { role: "user", content: contextText });
            appendToSession(chatJid, { role: "assistant", content: reply });
        }
        if (reply) rememberExchange(contact, question, reply, msg?.pushName);
    } catch (e) {
        log(`AI error: ${e instanceof Error ? e.message : String(e)}`);
        await sock.sendMessage(chatJid, { text: "😬 AI is unavailable right now — try again in a moment." });
    }
}

/** Reply inside an ongoing persona conversation (started by calling the persona's name). */
async function handleSessionReply(chatJid: string, text: string, msg: any): Promise<boolean> {
    const active = getActiveSession(chatJid);
    if (!active) return false;
    const s = settings();
    const persona = getPersona(s, active.persona);
    const preferred = getPersonaProvider(s, persona);
    if (!preferred) {
        endSession(chatJid);
        await sock.sendMessage(chatJid, { text: `⚠️ ${active.persona} left — no AI provider configured.` });
        return true;
    }
    const contact = senderDigits(msg);
    const base = persona?.instructions || s.aiSystemPrompt;
    const systemPrompt =
        `${base}\n\nYou are ${active.persona}, texting in an ongoing WhatsApp chat like a real person. ` +
        `You see the last few messages; keep the conversation flowing, match their tone, joke when it fits. ` +
        `Keep every reply to 1-2 short sentences. When the user says "enough", "stop" or "leave" you quietly leave.`;
    const history = active.history.slice();
    appendToSession(chatJid, { role: "user", content: text });
    try {
        const reply = await aiTurn(chatJid, contact, withQuote(msg, text), systemPrompt, history, preferred?.id, msg.pushName);
        if (reply) {
            await sock.sendMessage(chatJid, { text: reply }, { quoted: msg });
            appendToSession(chatJid, { role: "assistant", content: reply });
            rememberExchange(contact, text, reply, msg.pushName);
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
            try {
                const contact = senderDigits(msg);
                const ai = await aiTurn(chatJid, contact, text, rule.instructions, [], undefined, msg.pushName);
                if (ai) replyText = ai;
            } catch (e) { log(`Auto-respond AI failed, using canned reply: ${e instanceof Error ? e.message : String(e)}`); }
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
    if (msg.key.fromMe) return; // never answer your own outgoing messages (loop guard)
    if (!getChatToggles(chatJid).autoreply) return;

    const isGroup = chatJid.endsWith("@g.us");
    const admin = (s.adminNumber || "").replace(/\D/g, "");
    const from = senderDigits(msg);

    if (s.features.replyMode === "only" && admin && from !== admin) return;

    // The AI only speaks when called: "ai …" in a DM, or an actual @mention of the
    // bot in a group. Idle chat is never answered on its own.
    const prefixInvite = /^(ai|bot)\b[,:\s]/i.test(text.trim());
    const ownId = sock?.user?.id ? jidNormalizedUser(sock.user.id) : "";
    const mentioned = !!msg.message?.extendedTextMessage?.contextInfo?.mentionedJid
        ?.some((j: string) => jidNormalizedUser(j) === ownId);
    if (isGroup ? !(prefixInvite || mentioned) : !prefixInvite) return;

    const cleanText = text.trim().replace(/^(ai|bot)\b[,:\s]*/i, "").trim();
    if (!cleanText) return;

    const rule = firstMatchingRule(s.aiRules, cleanText);
    if (rule) {
        try { await sock.sendMessage(chatJid, { text: rule.response }, { quoted: msg }); } catch (e) { log(`rule reply failed: ${e}`); }
        return;
    }

    if (!(s.aiProviders ?? []).length) return;

    if (await maybeLinkAnswer(chatJid, cleanText)) return;

    try {
        const reply = await aiTurn(chatJid, from, withQuote(msg, cleanText), s.aiSystemPrompt, [], undefined, msg.pushName);
        if (reply) {
            await sock.sendMessage(chatJid, { text: reply }, { quoted: msg });
            rememberExchange(from, cleanText, reply, msg.pushName);
        }
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

    // Tear down any previous socket so reconnects don't leak sessions/listeners.
    if (sock) {
        try { sock.ev.removeAllListeners("connection.update"); } catch { }
        try { sock.ev.removeAllListeners("messages.upsert"); } catch { }
        try { sock.end(undefined); } catch { }
        sock = null;
    }

    let { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // Half-registered state (me written but registered=false) can never connect;
    // clear it so the next attempt starts from a fresh QR / pairing code.
    if (!state.creds.registered && state.creds.me) {
        log("🧹 Clearing half-finished registration");
        wipeAuthDir();
        ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
    }

    ipc({ type: "started", registered: state.creds.registered });

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
            const registered = state.creds.registered;

            if (code === DisconnectReason.loggedOut && registered) {
                wipeAuthDir();
                ipc({ type: "logged_out" });
                log("🚪 Logged out — credentials cleared");
                process.exit(0);
            }

            if (!registered) {
                // Pairing attempt died (expired/invalid code, QR replaced, 401…).
                // Report the reason and start clean so the next code actually works.
                const reason = (lastDisconnect?.error as any)?.message || `Pairing failed (${code ?? "connection closed"})`;
                pairingRequested = false;
                wipeAuthDir();
                ipc({ type: "pairing_error", error: `${reason} — request a new code` });
                log(`⚠️ ${reason} — restarting with fresh credentials`);
                if (reconnectTimer) return;
                reconnectTimer = setTimeout(() => {
                    reconnectTimer = null;
                    if (stopping) return;
                    run().catch((e) => { log(`Reconnect failed: ${e}`); });
                }, 3000);
                return;
            }

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

            // Remember who is talking and keep a rolling transcript for the memory learner.
            if (text) {
                if (msg.key.fromMe) {
                    // Outgoing messages mean the owner's account was active (used for "is Velrix online?").
                    recordSeen(storagePhone());
                } else {
                    const digits = senderDigits(msg);
                    recordSeen(digits);
                    if (!chatJid.endsWith("@g.us")) {
                        void appendTurn(SESSION_ID, digits, "user", text)
                            .then(() => learnIfNeeded(SESSION_ID, digits, msg.pushName, settings()))
                            .catch(() => { });
                    }
                }
            }

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
            if (cmd === "commands" || cmd === "cc") { handled = true; await socket.sendMessage(chatJid, { text: customCommandList() }); }
            if (cmd === "files") { handled = true; await socket.sendMessage(chatJid, { text: `📁 View all files: ${publicLink()}/my-files` }); }
            if ((cmd === "ai" || cmd === "bot") && args.length === 0) {
                // Bare "ai" calls the default assistant into the chat.
                handled = true;
                if (!owner && settings().features.replyMode === "only") {
                    await socket.sendMessage(chatJid, { text: "🔒 AI is limited to the admin in this mode." });
                } else {
                    startSession(chatJid, DEFAULT_PERSONA);
                    await socket.sendMessage(chatJid, { text: arrivalLine() });
                }
            }
            if (cmd.startsWith("ai/") || ((cmd === "ai" || cmd === "bot") && args.length > 0)) {
                handled = true;
                const question = args.join(" ").trim();
                if (!question) {
                    await socket.sendMessage(chatJid, { text: "Usage: ai <question> — or just type \"ai\" to call me in." });
                } else if (!owner && settings().features.replyMode === "only") {
                    await socket.sendMessage(chatJid, { text: "🔒 AI is limited to the admin in this mode." });
                } else {
                    await handleAiQuestion(chatJid, question, cmd.startsWith("ai/") ? cmd.slice(3) : undefined, false, msg);
                }
            }
            // Ongoing persona conversation — reply until the user says enough/stop
            // (checked before the name trigger so "nora enough" ends the chat)
            // Never triggered by the bot's own outgoing messages (loop guard).
            if (!handled && !msg.key.fromMe && text.trim()) {
                const active = getActiveSession(chatJid);
                if (active && isStopMessage(text, active.persona)) {
                    handled = true;
                    endSession(chatJid);
                    await socket.sendMessage(chatJid, { text: `👋 ${active.persona} left — say "${active.persona}" or "ai" when you need me again.` });
                }
            }
            // Persona by name: "Nora what is utc" / "@nora" / "nora, are you there"
            if (!handled && !msg.key.fromMe && text.trim()) {
                const pm = matchPersonaPrefix(text);
                if (pm) {
                    handled = true;
                    if (!owner && settings().features.replyMode === "only") {
                        await socket.sendMessage(chatJid, { text: "🔒 AI is limited to the admin in this mode." });
                    } else if (!pm.question) {
                        startSession(chatJid, pm.persona.name);
                        await socket.sendMessage(chatJid, { text: arrivalLine(pm.persona.name) });
                    } else {
                        await handleAiQuestion(chatJid, pm.question, pm.persona.name, true, msg);
                    }
                }
            }
            // Active persona chat — keep the conversation flowing
            if (!handled && !msg.key.fromMe && text.trim()) {
                const active = getActiveSession(chatJid);
                if (active) {
                    handled = true;
                    await handleSessionReply(chatJid, text, msg);
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
