import { Bot, InlineKeyboard } from "grammy";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawnWorker, killWorker, getWorker, getAllWorkers, workerEvents } from "./manager";
import { loadSettings, getActiveAiProvider } from "./settings";
import { callAiProvider, firstMatchingRule } from "./ai";

let supabase: any = null;
try {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
        supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { realtime: { transport: ws as any } });
    }
} catch (e) {
    console.error("Telegram: Supabase init failed:", e);
}

let bot: Bot | null = null;
let pollingActive = false;
let intentionalStop = false;

function hashPin(pin: string, phone: string) { return crypto.createHash("sha256").update(`${phone}:${pin}:wabot`).digest("hex"); }

// ── Persisted per-chat state (survives restarts) ────────────────────────
type ChatState = { phones: string[]; stage?: "awaiting_phone" | "awaiting_pin"; targetPhone?: string };
const STATE_FILE = path.join(process.cwd(), "data", "telegram-state.json");
const userState = new Map<number, ChatState>();

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Record<string, ChatState>;
            for (const [k, v] of Object.entries(parsed)) userState.set(Number(k), v);
        }
    } catch { /* ignore */ }
}
function saveState() {
    try {
        const obj: Record<string, ChatState> = {};
        for (const [k, v] of userState) obj[k] = { phones: v.phones }; // persist phones only
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2));
    } catch { /* ignore */ }
}
function stateFor(chatId: number): ChatState {
    let s = userState.get(chatId);
    if (!s) { s = { phones: [] }; userState.set(chatId, s); }
    return s;
}

function watchAndDeleteOnConnect(sessionId: string, chatId: number, messageId: number) {
    const handler = async () => {
        try { await bot!.api.deleteMessage(chatId, messageId); } catch { }
        workerEvents.removeListener(`connected:${sessionId}`, handler);
    };
    workerEvents.once(`connected:${sessionId}`, handler);
    setTimeout(() => workerEvents.removeListener(`connected:${sessionId}`, handler), 5 * 60 * 1000);
}

const MENU_TEXT = `🤖 *Bot Menu*\n\n` +
    `/link — add a WhatsApp number\n` +
    `/status — check connections\n` +
    `/files — open saved media\n` +
    `/register — set a web PIN\n` +
    `/unlink — remove a number\n` +
    `/ping — check the bot is alive\n` +
    `/menu — show this menu\n\n` +
    `💬 Just send any text and I'll reply with AI (if enabled).`;

function menuKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
        .text("🔗 Link", "menu:link").text("📊 Status", "menu:status").row()
        .text("📁 Files", "menu:files").text("🔓 Unlink", "menu:unlink").row()
        .text("❔ Help", "menu:help");
}

function registerHandlers(b: Bot) {
    b.command("start", async (ctx) => {
        await ctx.reply(`👋 Welcome!\n\nUse /menu to see everything I can do.`, { reply_markup: menuKeyboard() });
    });

    b.command("menu", async (ctx) => {
        await ctx.reply(MENU_TEXT, { parse_mode: "Markdown", reply_markup: menuKeyboard() });
    });

    b.command("help", async (ctx) => {
        await ctx.reply(MENU_TEXT, { parse_mode: "Markdown", reply_markup: menuKeyboard() });
    });

    b.command("ping", async (ctx) => {
        await ctx.reply(`🏓 Pong! Uptime ${Math.floor(process.uptime())}s`);
    });

    b.command("files", async (ctx) => {
        await ctx.reply(`📁 Saved media:\n${process.env.PUBLIC_URL}/my-files`);
    });

    b.command("link", async (ctx) => {
        const state = stateFor(ctx.chat.id);
        state.stage = "awaiting_phone";
        await ctx.reply(`📱 Send your WhatsApp number with country code (e.g. 2348103077073)`);
    });

    b.command("register", async (ctx) => {
        const state = stateFor(ctx.chat.id);
        if (!state.phones.length) { await ctx.reply("❌ Link a number first using /link"); return; }

        if (state.phones.length === 1) {
            state.stage = "awaiting_pin";
            state.targetPhone = state.phones[0];
            await ctx.reply(`🔐 Send a 4-digit PIN for +${state.phones[0]}\nYou'll use it to log in at ${process.env.PUBLIC_URL}/my-files`); return;
        }

        const kb = new InlineKeyboard();
        state.phones.forEach(p => kb.text(`+${p}`, `pinreg:${p}`).row());
        await ctx.reply("Which number do you want to set a PIN for?", { reply_markup: kb });
    });

    b.command("status", async (ctx) => {
        const state = stateFor(ctx.chat.id);
        const phones = state.phones.length ? state.phones : getAllWorkers().map(w => w.phone || w.sessionId.replace(/^user_/, ""));
        if (!phones.length) { await ctx.reply("❌ No linked numbers. Use /link"); return; }

        let msg = "📱 *Linked Numbers*\n\n";
        for (const phone of phones) {
            const w = getWorker(`user_${phone}`);
            const icon = w?.status === "connected" ? "✅" : w?.status === "qr" || w?.status === "connecting" ? "⏳" : "⚠️";
            msg += `${icon} +${phone} — ${w?.status || "offline"}\n`;
        }
        await ctx.reply(msg, { parse_mode: "Markdown" });
    });

    b.command("unlink", async (ctx) => {
        const state = stateFor(ctx.chat.id);
        const phones = state.phones.length ? state.phones : getAllWorkers().map(w => w.phone || w.sessionId.replace(/^user_/, ""));
        if (!phones.length) { await ctx.reply("❌ Nothing to unlink."); return; }

        const kb = new InlineKeyboard();
        phones.forEach(p => kb.text(`+${p}`, `unlink:${p}`).row());
        await ctx.reply("Which number do you want to unlink?", { reply_markup: kb });
    });

    b.callbackQuery("menu:link", async (ctx) => { await ctx.answerCallbackQuery(); const s = stateFor(ctx.chat!.id); s.stage = "awaiting_phone"; await ctx.reply("📱 Send your WhatsApp number with country code."); });
    b.callbackQuery("menu:status", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply("Use /status"); });
    b.callbackQuery("menu:files", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply(`📁 ${process.env.PUBLIC_URL}/my-files`); });
    b.callbackQuery("menu:unlink", async (ctx) => {
        await ctx.answerCallbackQuery();
        const phones = stateFor(ctx.chat!.id).phones;
        if (!phones.length) { await ctx.reply("Nothing to unlink."); return; }
        const kb = new InlineKeyboard();
        phones.forEach(p => kb.text(`+${p}`, `unlink:${p}`).row());
        await ctx.reply("Pick a number:", { reply_markup: kb });
    });
    b.callbackQuery("menu:help", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply(MENU_TEXT, { parse_mode: "Markdown" }); });

    b.callbackQuery(/^pinreg:/, async (ctx) => {
        const phone = ctx.callbackQuery.data.split(":")[1];
        const state = stateFor(ctx.chat!.id);
        state.stage = "awaiting_pin";
        state.targetPhone = phone;
        await ctx.answerCallbackQuery();
        await ctx.reply(`🔐 Send a 4-digit PIN for +${phone}`);
    });

    b.callbackQuery(/^unlink:/, async (ctx) => {
        const phone = ctx.callbackQuery.data.split(":")[1];
        killWorker(`user_${phone}`);
        const state = stateFor(ctx.chat!.id);
        state.phones = state.phones.filter(p => p !== phone);
        saveState();
        await ctx.answerCallbackQuery();
        await ctx.reply(`✅ Unlinked +${phone}.`);
    });

    b.on("message:text", async (ctx) => {
        const state = userState.get(ctx.chat.id);
        const text = ctx.message.text.trim();

        if (state?.stage === "awaiting_phone") {
            const clean = text.replace(/\D/g, "");
            if (clean.length < 10) { await ctx.reply("❌ Invalid number."); return; }
            if (!state.phones.includes(clean)) state.phones.push(clean);
            state.stage = undefined;
            saveState();

            const kb = new InlineKeyboard().text("🔢 Get Pairing Code", `pair:${clean}`);
            await ctx.reply(`Ready to link +${clean}?`, { reply_markup: kb });
            return;
        }

        if (state?.stage === "awaiting_pin" && state.targetPhone) {
            if (!/^\d{4}$/.test(text)) { await ctx.reply("❌ PIN must be 4 digits."); return; }
            const hash = hashPin(text, state.targetPhone);

            if (supabase) {
                const { data: existing } = await supabase.from("users").select("phone").eq("phone", state.targetPhone).maybeSingle();
                if (existing) await supabase.from("users").update({ pin_hash: hash }).eq("phone", state.targetPhone);
                else {
                    await supabase.from("users").insert({ phone: state.targetPhone, pin_hash: hash });
                    await supabase.from("user_settings").insert({ phone: state.targetPhone });
                }
            }

            state.stage = undefined;
            await ctx.reply(`✅ PIN set for +${state.targetPhone}!\n\nLogin at:\n${process.env.PUBLIC_URL}/my-files`);
            return;
        }

        // Free text → AI reply
        await handleAiText(ctx, text);
    });

    b.callbackQuery(/^pair:/, async (ctx) => {
        const phone = ctx.callbackQuery.data.split(":")[1];
        const sessionId = `user_${phone}`;

        await ctx.answerCallbackQuery();
        const existing = getWorker(sessionId);
        if (existing?.status === "connected") {
            await ctx.reply(`✅ +${phone} is already linked.`); return;
        }

        await ctx.reply("⏳ Requesting pairing code…");

        const codePromise = new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => { cleanup(); reject(new Error("Timeout. WhatsApp is not responding.")); }, 90000);
            const onPairing = (c: string) => { cleanup(); resolve(c); };
            const onError = (err: string) => { cleanup(); reject(new Error(err)); };
            const cleanup = () => {
                clearTimeout(timer);
                workerEvents.removeListener(`pairing:${sessionId}`, onPairing);
                workerEvents.removeListener(`pairing_error:${sessionId}`, onError);
                workerEvents.removeListener(`error:${sessionId}`, onError);
            };
            workerEvents.once(`pairing:${sessionId}`, onPairing);
            workerEvents.once(`pairing_error:${sessionId}`, onError);
            workerEvents.once(`error:${sessionId}`, onError);
        });

        // Reuse a live worker; only spawn if none exists.
        if (!existing || existing.status === "disconnected") spawnWorker(sessionId, phone);

        try {
            const code = await codePromise;
            const sent = await ctx.reply(`🔢 Your code: \`${code}\`\n\n⚡ Open WhatsApp → Linked Devices → Link with Phone Number.`, { parse_mode: "Markdown" });
            watchAndDeleteOnConnect(sessionId, ctx.chat!.id, sent.message_id);
        } catch (err: any) {
            await ctx.reply(`❌ Pairing failed:\n\n${err.message}`);
        }
    });
}

async function handleAiText(ctx: any, text: string) {
    const s = loadSettings();
    if (!s.features?.aiChat || !text) return;

    const rule = firstMatchingRule(s.aiRules, text);
    if (rule) { await ctx.reply(rule.response); return; }

    const provider = getActiveAiProvider(s);
    if (!provider) { await ctx.reply("ℹ️ No AI provider configured. Add one in the admin panel."); return; }

    try {
        await ctx.replyWithChatAction("typing").catch(() => { });
        const reply = await callAiProvider(provider, text, s.aiSystemPrompt);
        await ctx.reply(reply || "(no response)");
    } catch (e) {
        await ctx.reply(`❌ AI error: ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function runPolling() {
    if (!bot || pollingActive || intentionalStop) return;
    pollingActive = true;
    try {
        await bot.start({
            drop_pending_updates: false,
            onStart: (me) => console.log(`✅ Telegram bot @${me.username} started`),
        });
    } catch (e) {
        console.error("Telegram polling stopped with error:", e);
    } finally {
        pollingActive = false;
    }
    if (!intentionalStop) {
        console.warn("Telegram polling ended — restarting in 5s");
        setTimeout(() => { void runPolling(); }, 5000);
    }
}

export function startTelegramBot() {
    loadState();
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.error("❌ TELEGRAM_BOT_TOKEN is not set — Telegram bot disabled");
        return;
    }
    if (bot) return;

    try {
        bot = new Bot(token);
    } catch (e) {
        console.error("❌ Failed to create Telegram bot:", e);
        return;
    }

    bot.catch((err) => {
        console.error("Telegram handler error:", err.error ?? err);
    });

    registerHandlers(bot);

    bot.api.setMyCommands([
        { command: "menu", description: "Show the menu" },
        { command: "link", description: "Link a WhatsApp number" },
        { command: "status", description: "Check connections" },
        { command: "files", description: "Open saved media" },
        { command: "register", description: "Set a web PIN" },
        { command: "unlink", description: "Remove a number" },
        { command: "ping", description: "Check the bot is alive" },
        { command: "help", description: "Help" },
    ]).catch((e) => console.error("setMyCommands failed:", e));

    void runPolling();
}

export function stopTelegramBot() {
    intentionalStop = true;
    if (bot) { try { bot.stop(); } catch { } }
}
