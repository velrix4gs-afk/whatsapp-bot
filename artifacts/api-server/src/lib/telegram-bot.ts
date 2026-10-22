import { Bot, InlineKeyboard, InputFile } from "grammy";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import crypto from "crypto";
import { spawnWorker, killWorker, getWorker, workerEvents } from "./manager";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { realtime: { transport: ws as any } });
let bot: Bot | null = null;

function hashPin(pin: string, phone: string) { return crypto.createHash("sha256").update(`${phone}:${pin}:wabot`).digest("hex"); }

const userState = new Map<number, { phones: string[]; stage?: "awaiting_phone" | "awaiting_pin"; targetPhone?: string }>();

function waitForEvent<T>(eventName: string, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { workerEvents.removeListener(eventName, handler); reject(new Error("Timeout")); }, timeoutMs);
        const handler = (data: T) => { clearTimeout(timer); workerEvents.removeListener(eventName, handler); resolve(data); };
        workerEvents.once(eventName, handler);
    });
}

function watchAndDeleteOnConnect(sessionId: string, chatId: number, messageId: number, successMsg: string) {
    const handler = async () => {
        try { await bot!.api.deleteMessage(chatId, messageId); } catch { }
        try { await bot!.api.sendMessage(chatId, successMsg, { parse_mode: "Markdown" }); } catch { }
        workerEvents.removeListener(`connected:${sessionId}`, handler);
    };
    workerEvents.once(`connected:${sessionId}`, handler);
    setTimeout(() => workerEvents.removeListener(`connected:${sessionId}`, handler), 5 * 60 * 1000);
}

export function startTelegramBot() {
    bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

    bot.command("start", async (ctx) => {
        await ctx.reply(`👋 Welcome!\n\n/link - Add a WhatsApp number\n/register - Set PIN for web access\n/status - Check connections\n/unlink - Remove a number`);
    });

    bot.command("link", async (ctx) => {
        const state = userState.get(ctx.chat.id) || { phones: [] };
        state.stage = "awaiting_phone";
        userState.set(ctx.chat.id, state);
        await ctx.reply(`📱 Send your WhatsApp number with country code (e.g. \`2348103077073\`)`);
    });

    bot.command("register", async (ctx) => {
        const state = userState.get(ctx.chat.id);
        if (!state || state.phones.length === 0) return ctx.reply("❌ Link a number first using /link");

        if (state.phones.length === 1) {
            state.stage = "awaiting_pin";
            state.targetPhone = state.phones[0];
            userState.set(ctx.chat.id, state);
            return ctx.reply(`🔐 Send a 4-digit PIN for +${state.phones[0]}`);
        }

        // Multiple numbers -> Show buttons
        const kb = new InlineKeyboard();
        state.phones.forEach(p => kb.text(`+${p}`, `pinreg:${p}`).row());
        await ctx.reply("Which number do you want to set a PIN for?", { reply_markup: kb });
    });

    bot.callbackQuery(/^pinreg:/, async (ctx) => {
        const phone = ctx.match[1];
        const state = userState.get(ctx.chat.id) || { phones: [] };
        state.stage = "awaiting_pin";
        state.targetPhone = phone;
        userState.set(ctx.chat.id, state);
        await ctx.answerCallbackQuery();
        await ctx.reply(`🔐 Send a 4-digit PIN for +${phone}`);
    });

    bot.on("message:text", async (ctx) => {
        const state = userState.get(ctx.chat.id);
        if (!state) return;
        const text = ctx.message.text.trim();

        if (state.stage === "awaiting_phone") {
            const clean = text.replace(/\D/g, "");
            if (clean.length < 10) return ctx.reply("❌ Invalid number.");

            if (!state.phones.includes(clean)) state.phones.push(clean);
            state.stage = undefined;
            userState.set(ctx.chat.id, state);

            const kb = new InlineKeyboard().text("🔳 QR", `qr:${clean}`).text("🔢 Pairing Code", `pair:${clean}`);
            await ctx.reply(`How do you want to link +${clean}?`, { reply_markup: kb });
        }

        if (state.stage === "awaiting_pin" && state.targetPhone) {
            if (!/^\d{4}$/.test(text)) return ctx.reply("❌ PIN must be 4 digits.");
            const hash = hashPin(text, state.targetPhone);

            const { data: existing } = await supabase.from("users").select("phone").eq("phone", state.targetPhone).maybeSingle();
            if (existing) await supabase.from("users").update({ pin_hash: hash }).eq("phone", state.targetPhone);
            else {
                await supabase.from("users").insert({ phone: state.targetPhone, pin_hash: hash });
                await supabase.from("user_settings").insert({ phone: state.targetPhone });
            }

            state.stage = undefined;
            userState.set(ctx.chat.id, state);
            await ctx.reply(`✅ PIN set for +${state.targetPhone}!\nLogin at ${process.env.PUBLIC_URL}/my-files`);
        }
    });

    bot.callbackQuery(/^(qr|pair):/, async (ctx) => {
        const [action, phone] = ctx.match[0].split(":");
        const sessionId = `user_${phone}`;
        await ctx.answerCallbackQuery();
        killWorker(sessionId);
        await new Promise(r => setTimeout(r, 500));

        if (action === "qr") {
            spawnWorker(sessionId);
            await ctx.reply("⏳ Generating QR...");
            try {
                const qr = await waitForEvent<string>(`qr:${sessionId}`, 20000);
                const buf = Buffer.from(qr.split(",")[1], "base64");
                await ctx.replyWithPhoto(new InputFile(buf, "qr.png"), { caption: "Scan this in WhatsApp" });
            } catch { await ctx.reply("❌ QR Timeout. Try again."); }
        } else {
            spawnWorker(sessionId, phone);
            await ctx.reply("⏳ Requesting Pairing Code...");
            try {
                const code = await waitForEvent<string>(`pairing:${sessionId}`, 30000);
                await ctx.reply(`🔢 Your code: \`${code}\`\nEnter it in WhatsApp FAST.`, { parse_mode: "Markdown" });
            } catch { await ctx.reply("❌ Pairing failed. Try again."); }
        }
    });

    bot.start({ onStart: () => console.log("✅ Telegram Bot Started") });
}   