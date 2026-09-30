import { Bot, InlineKeyboard, InputFile } from "grammy";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import crypto from "crypto";
import {
    spawnWorker,
    killWorker,
    getWorker,
    workerEvents,
} from "./manager";

let bot: Bot | null = null;

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    { realtime: { transport: ws as any } }
);

function hashPin(pin: string, phone: string): string {
    return crypto.createHash("sha256").update(`${phone}:${pin}:wabot`).digest("hex");
}

const userState = new Map<number, {
    phone?: string;
    sessionId?: string;
    stage?: "awaiting_phone" | "awaiting_pin";
}>();

function waitForEvent<T>(eventName: string, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            workerEvents.removeListener(eventName, handler);
            reject(new Error(`Timeout waiting for ${eventName}`));
        }, timeoutMs);

        const handler = (data: T) => {
            clearTimeout(timer);
            workerEvents.removeListener(eventName, handler);
            resolve(data);
        };

        workerEvents.once(eventName, handler);
    });
}

function watchAndDeleteOnConnect(
    sessionId: string,
    chatId: number,
    messageId: number,
    successMsg: string
) {
    const handler = async () => {
        try { await bot!.api.deleteMessage(chatId, messageId); } catch { }
        try {
            await bot!.api.sendMessage(chatId, successMsg, { parse_mode: "Markdown" });
        } catch { }
        workerEvents.removeListener(`connected:${sessionId}`, handler);
    };

    workerEvents.once(`connected:${sessionId}`, handler);

    setTimeout(() => {
        workerEvents.removeListener(`connected:${sessionId}`, handler);
    }, 5 * 60 * 1000);
}

export function startTelegramBot(): void {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.warn("⚠️ TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
        return;
    }

    bot = new Bot(token);

    bot.command("start", async (ctx) => {
        const name = ctx.from?.first_name ?? "there";
        await ctx.reply(
            `👋 Hey ${name}!\n\n` +
            `I'm *Nova* — I manage your WhatsApp bot.\n\n` +
            `📱 *Commands:*\n` +
            `/link — Link your WhatsApp number\n` +
            `/register — Set your PIN for web access\n` +
            `/status — Check your link status\n` +
            `/unlink — Disconnect your WhatsApp\n` +
            `/help — Show this menu`,
            { parse_mode: "Markdown" }
        );
    });

    bot.command("help", async (ctx) => {
        await ctx.reply(
            `📖 *Available Commands*\n\n` +
            `/link — Link your WhatsApp number\n` +
            `/register — Set your PIN for web access\n` +
            `/status — Check your link status\n` +
            `/unlink — Disconnect your WhatsApp\n` +
            `/help — Show this menu`,
            { parse_mode: "Markdown" }
        );
    });

    bot.command("link", async (ctx) => {
        const chatId = ctx.chat.id;
        userState.set(chatId, { stage: "awaiting_phone" });
        await ctx.reply(
            `📱 *Link Your WhatsApp*\n\n` +
            `Send me your WhatsApp number with country code.\n\n` +
            `*Example:* \`2348103077073\``,
            { parse_mode: "Markdown" }
        );
    });

    bot.command("register", async (ctx) => {
        const chatId = ctx.chat.id;
        const state = userState.get(chatId) || {};

        if (!state.phone) {
            await ctx.reply(
                `❌ You need to link a WhatsApp number first.\n\nUse /link to get started.`
            );
            return;
        }

        state.stage = "awaiting_pin";
        userState.set(chatId, state);

        await ctx.reply(
            `🔐 *Set Your PIN*\n\n` +
            `Send a 4-digit PIN. You'll use it to log in to /my-files.\n\n` +
            `*Example:* \`1234\``,
            { parse_mode: "Markdown" }
        );
    });

    bot.command("status", async (ctx) => {
        const chatId = ctx.chat.id;
        const state = userState.get(chatId);

        if (!state?.sessionId) {
            await ctx.reply(`❌ You don't have a linked number yet. Use /link.`);
            return;
        }

        const w = getWorker(state.sessionId);
        if (!w) {
            await ctx.reply(`❌ No active worker. Try /link again.`);
            return;
        }

        const icon = w.status === "connected" ? "✅" : "⚠️";
        let msg =
            `${icon} *Status:* ${w.status}\n` +
            `📱 *Phone:* +${w.phoneNumber ?? state.phone ?? "unknown"}\n` +
            `🆔 *Session:* \`${w.sessionId}\``;

        await ctx.reply(msg, { parse_mode: "Markdown" });
    });

    bot.command("unlink", async (ctx) => {
        const chatId = ctx.chat.id;
        const state = userState.get(chatId);
        if (!state?.sessionId) {
            await ctx.reply(`❌ Nothing to unlink.`);
            return;
        }
        killWorker(state.sessionId);
        userState.delete(chatId);
        await ctx.reply(`✅ WhatsApp unlinked.`);
    });

    // Phone number / PIN input
    bot.on("message:text", async (ctx) => {
        const chatId = ctx.chat.id;
        const text = ctx.message.text.trim();
        const state = userState.get(chatId);
        if (!state) return;

        // ── PIN input ────────────────────────────────────────────────
        if (state.stage === "awaiting_pin") {
            const pin = text.replace(/\D/g, "");

            if (pin.length !== 4) {
                await ctx.reply(`❌ PIN must be exactly 4 digits. Try again.`);
                return;
            }

            try {
                const pinHash = hashPin(pin, state.phone!);

                const { data: existing } = await supabase
                    .from("users")
                    .select("phone")
                    .eq("phone", state.phone!)
                    .maybeSingle();

                if (existing) {
                    await supabase
                        .from("users")
                        .update({ pin_hash: pinHash })
                        .eq("phone", state.phone!);
                } else {
                    await supabase
                        .from("users")
                        .insert({ phone: state.phone!, pin_hash: pinHash });

                    await supabase
                        .from("user_settings")
                        .insert({ phone: state.phone! });
                }

                state.stage = undefined;
                userState.set(chatId, state);

                await ctx.reply(
                    `✅ *PIN set!*\n\n` +
                    `Login anytime at:\n` +
                    `${process.env.PUBLIC_URL || 'http://localhost:8080'}/my-files\n\n` +
                    `📱 Phone: \`${state.phone}\`\n` +
                    `🔐 PIN: \`${pin}\``,
                    { parse_mode: "Markdown" }
                );
            } catch (e) {
                await ctx.reply(`❌ Error: ${(e as Error).message}`);
            }
            return;
        }

        // ── Phone input ──────────────────────────────────────────────
        if (state.stage === "awaiting_phone") {
            const cleanPhone = text.replace(/\D/g, "");
            if (cleanPhone.length < 10) {
                await ctx.reply(
                    `❌ Invalid number. Send it like: \`2348103077073\``,
                    { parse_mode: "Markdown" }
                );
                return;
            }

            state.phone = cleanPhone;
            state.sessionId = `user_${cleanPhone}`;
            state.stage = undefined;
            userState.set(chatId, state);

            const kb = new InlineKeyboard()
                .text("🔳 QR Code", `qr:${cleanPhone}`)
                .text("🔢 Pairing Code", `pair:${cleanPhone}`);

            await ctx.reply(
                `Got it: *+${cleanPhone}*\n\nHow do you want to link?`,
                { parse_mode: "Markdown", reply_markup: kb }
            );
            return;
        }
    });

    // Button clicks
    bot.on("callback_query:data", async (ctx) => {
        const data = ctx.callbackQuery.data;
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        const [action, phone] = data.split(":");
        const sessionId = `user_${phone}`;

        await ctx.answerCallbackQuery();

        try {
            killWorker(sessionId);
            await new Promise((r) => setTimeout(r, 500));

            // Save the phone to user state so /register works
            const st = userState.get(chatId) || {};
            st.phone = phone;
            st.sessionId = sessionId;
            userState.set(chatId, st);

            if (action === "qr") {
                spawnWorker(sessionId);
                await ctx.reply(`⏳ Generating QR code... (up to 20 seconds)`);

                try {
                    const qrDataUrl = await waitForEvent<string>(`qr:${sessionId}`, 20_000);
                    const base64 = qrDataUrl.split(",")[1];
                    const buffer = Buffer.from(base64, "base64");

                    const sent = await ctx.replyWithPhoto(
                        new InputFile(buffer, "qr.png"),
                        {
                            caption:
                                `🔳 *Scan this QR code*\n\n` +
                                `WhatsApp → Settings → Linked Devices → Link a Device\n\n` +
                                `_This message auto-deletes once linked._`,
                            parse_mode: "Markdown",
                        }
                    );

                    watchAndDeleteOnConnect(
                        sessionId,
                        chatId,
                        sent.message_id,
                        `✅ *WhatsApp linked successfully!*\n\nUse /register to set your PIN for web access.`
                    );
                } catch (err) {
                    await ctx.reply(`❌ QR not ready after 20s. Try again or use pairing code.`);
                }
            } else if (action === "pair") {
                spawnWorker(sessionId, phone);
                await ctx.reply(`⏳ Generating pairing code... (up to 30 seconds)`);

                try {
                    const code = await waitForEvent<string>(`pairing:${sessionId}`, 30_000);

                    const sent = await ctx.reply(
                        `🔢 *Pairing Code*\n\n` +
                        `\`${code}\`\n\n` +
                        `WhatsApp → Settings → Linked Devices → Link with Phone Number\n\n` +
                        `⚡ *Enter this code FAST — it expires in ~20 seconds.*`,
                        { parse_mode: "Markdown" }
                    );

                    watchAndDeleteOnConnect(
                        sessionId,
                        chatId,
                        sent.message_id,
                        `✅ *WhatsApp linked successfully!*\n\nUse /register to set your PIN for web access.`
                    );
                } catch (err) {
                    await ctx.reply(`❌ Pairing code not ready after 30s.\n\nTry again.`);
                }
            }
        } catch (e) {
            await ctx.reply(`❌ Error: ${(e as Error).message}`);
        }
    });

    bot.catch((err) => {
        console.error("Telegram bot error:", err);
    });

    bot.start({
        onStart: () => console.log("✅ Telegram bot started (@nova_wa_bot)"),
    });
}

export function getBot(): Bot | null {
    return bot;
}   