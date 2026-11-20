import { Bot, InlineKeyboard, InputFile } from "grammy";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import crypto from "crypto";
import { spawnWorker, killWorker, getWorker, workerEvents } from "./manager";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { realtime: { transport: ws as any } });
let bot: Bot | null = null;

function hashPin(pin: string, phone: string) { return crypto.createHash("sha256").update(`${phone}:${pin}:wabot`).digest("hex"); }

const userState = new Map<number, { phones: string[]; stage?: "awaiting_phone" | "awaiting_pin"; targetPhone?: string }>();

function watchAndDeleteOnConnect(sessionId: string, chatId: number, messageId: number) {
    const handler = async () => {
        try { await bot!.api.deleteMessage(chatId, messageId); } catch { }
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
        if (!ctx.chat) return;
        const state = userState.get(ctx.chat.id) || { phones: [] };
        state.stage = "awaiting_phone";
        userState.set(ctx.chat.id, state);
        await ctx.reply(`📱 Send your WhatsApp number with country code (e.g. \`2348103077073\`)`);
    });

    bot.command("register", async (ctx) => {
        const state = userState.get(ctx.chat.id);
        if (!state || state.phones.length === 0) return void ctx.reply("❌ Link a number first using /link");

        if (state.phones.length === 1) {
            state.stage = "awaiting_pin";
            state.targetPhone = state.phones[0];
            userState.set(ctx.chat.id, state);
            return void ctx.reply(`🔐 Send a 4-digit PIN for +${state.phones[0]}\nYou will use this to login to ${process.env.PUBLIC_URL}/my-files`);
        }

        const kb = new InlineKeyboard();
        state.phones.forEach(p => kb.text(`+${p}`, `pinreg:${p}`).row());
        await ctx.reply("Which number do you want to set a PIN for?", { reply_markup: kb });
    });

    bot.command("status", async (ctx) => {
        const state = userState.get(ctx.chat.id);
        if (!state || state.phones.length === 0) return void ctx.reply("❌ No linked numbers. Use /link");

        let msg = "📱 *Your Linked Numbers:*\n\n";
        for (const phone of state.phones) {
            const sessionId = `user_${phone}`;
            const w = getWorker(sessionId);
            const icon = w?.status === "connected" ? "✅" : "⚠️";
            msg += `${icon} +${phone} (${w?.status || "offline"})\n`;
        }
        await ctx.reply(msg, { parse_mode: "Markdown" });
    });

    bot.command("unlink", async (ctx) => {
        if (!ctx.chat) return;
        const state = userState.get(ctx.chat.id);
        if (!state || state.phones.length === 0) return void ctx.reply("❌ Nothing to unlink.");

        if (state.phones.length === 1) {
            const phone = state.phones[0];
            killWorker(`user_${phone}`);
            state.phones = [];
            userState.set(ctx.chat.id, state);
            return void ctx.reply(`✅ Unlinked +${phone}.`);
        }

        const kb = new InlineKeyboard();
        state.phones.forEach(p => kb.text(`+${p}`, `unlink:${p}`).row());
        await ctx.reply("Which number do you want to unlink?", { reply_markup: kb });
    });

    bot.callbackQuery(/^unlink:/, async (ctx) => {
        if (!ctx.chat) return;
        const phone = ctx.callbackQuery.data.split(":")[1];
        const state = userState.get(ctx.chat.id);
        if (!state) return void ctx.answerCallbackQuery("State lost, try /unlink again");

        killWorker(`user_${phone}`);
        state.phones = state.phones.filter(p => p !== phone);
        userState.set(ctx.chat.id, state);
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`✅ Unlinked +${phone}.`);
    });

    bot.callbackQuery(/^pinreg:/, async (ctx) => {
        if (!ctx.chat) return;
        const phone = ctx.callbackQuery.data.split(":")[1];
        const state = userState.get(ctx.chat.id) || { phones: [] };
        state.stage = "awaiting_pin";
        state.targetPhone = phone;
        userState.set(ctx.chat.id, state);
        await ctx.answerCallbackQuery();
        await ctx.reply(`🔐 Send a 4-digit PIN for +${phone}`);
    });

    bot.on("message:text", async (ctx) => {
        if (!ctx.chat) return;
        const state = userState.get(ctx.chat.id);
        if (!state) return;
        const text = ctx.message?.text?.trim();
        if (!text) return;

        if (state.stage === "awaiting_phone") {
            const clean = text.replace(/\D/g, "");
            if (clean.length < 10) return void ctx.reply("❌ Invalid number.");

            if (!state.phones.includes(clean)) state.phones.push(clean);
            state.stage = undefined;
            userState.set(ctx.chat.id, state);

            const kb = new InlineKeyboard().text("🔢 Get Pairing Code", `pair:${clean}`);
            await ctx.reply(`Ready to link +${clean}?`, { reply_markup: kb });
        }

        if (state.stage === "awaiting_pin" && state.targetPhone) {
            if (!/^\d{4}$/.test(text)) return void ctx.reply("❌ PIN must be 4 digits.");
            const hash = hashPin(text, state.targetPhone);

            const { data: existing } = await supabase.from("users").select("phone").eq("phone", state.targetPhone).maybeSingle();
            if (existing) await supabase.from("users").update({ pin_hash: hash }).eq("phone", state.targetPhone);
            else {
                await supabase.from("users").insert({ phone: state.targetPhone, pin_hash: hash });
                await supabase.from("user_settings").insert({ phone: state.targetPhone });
            }

            state.stage = undefined;
            userState.set(ctx.chat.id, state);
            await ctx.reply(`✅ PIN set for +${state.targetPhone}!\n\nLogin at:\n${process.env.PUBLIC_URL}/my-files`);
        }
    });

    bot.callbackQuery(/^pair:/, async (ctx) => {
        if (!ctx.chat) return;
        const phone = ctx.callbackQuery.data.split(":")[1];
        const sessionId = `user_${phone}`;

        await ctx.answerCallbackQuery();
        
        // Wait for any existing worker to fully stop before spawning new one
        const existing = getWorker(sessionId);
        if (existing) {
            killWorker(sessionId);
            await new Promise(r => setTimeout(r, 1500)); // Give time for clean shutdown
        }

        await ctx.reply("⏳ Starting WhatsApp connection...");

        // Spawn worker FIRST, then wait for it to be ready
        spawnWorker(sessionId, phone);

        // Wait for worker to be in "connecting" state (socket created)
        let workerReady = false;
        for (let i = 0; i < 30; i++) { // Max 30 seconds
            await new Promise(r => setTimeout(r, 1000));
            const w = getWorker(sessionId);
            if (w && (w.status === "connecting" || w.status === "qr")) {
                workerReady = true;
                break;
            }
        }

        if (!workerReady) {
            await ctx.reply("❌ Worker failed to start. Please try again.");
            return;
        }

        await ctx.editMessageText("⏳ Requesting Pairing Code...");

        const codePromise = new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => { cleanup(); reject(new Error("Timeout. WhatsApp did not provide a pairing code in 60 seconds.")); }, 60000);
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

        try {
            const code = await codePromise;
            const sentMsg = await ctx.editMessageText(`🔢 Your code: \`${code}\`\n\n⚡ **HURRY!**\nOpen WhatsApp → Linked Devices → Link with Phone Number.\nYou only have **20 seconds** to type this in!`, { parse_mode: "Markdown" });
            if (sentMsg && typeof sentMsg === "object" && "message_id" in sentMsg) {
                watchAndDeleteOnConnect(sessionId, ctx.chat.id, sentMsg.message_id);
            }
        } catch (err: any) {
            await ctx.editMessageText(`❌ Pairing failed:\n\n${err.message}\n\nTry again in a moment.`);
        }
    });

    bot.start({ onStart: () => console.log("✅ Telegram Bot Started") });
}