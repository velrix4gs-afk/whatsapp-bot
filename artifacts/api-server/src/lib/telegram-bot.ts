import { Bot, InlineKeyboard } from "grammy";
import {
    startSession,
    requestPairingCode,
    getSessionState,
    getAllSessions,
    deleteSession,
} from "./whatsapp-bot";

let bot: Bot | null = null;

// Track user state: chat_id → { phone, sessionId, stage }
const userState = new Map<number, {
    phone?: string;
    sessionId?: string;
    stage?: "awaiting_phone" | "awaiting_choice";
}>();

export function startTelegramBot(): void {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.warn("⚠️ TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
        return;
    }

    bot = new Bot(token);

    // ── /start ────────────────────────────────────────────────────────
    bot.command("start", async (ctx) => {
        const name = ctx.from?.first_name ?? "there";
        await ctx.reply(
            `👋 Hey ${name}!\n\n` +
            `I'm *Nova* — I manage your WhatsApp bot.\n\n` +
            `📱 *Commands:*\n` +
            `/link — Link your WhatsApp number\n` +
            `/status — Check your link status\n` +
            `/settings — Manage your features\n` +
            `/unlink — Disconnect your WhatsApp\n` +
            `/help — Show this menu`,
            { parse_mode: "Markdown" }
        );
    });

    // ── /help ─────────────────────────────────────────────────────────
    bot.command("help", async (ctx) => {
        await ctx.reply(
            `📖 *Available Commands*\n\n` +
            `/link — Link your WhatsApp number\n` +
            `/status — Check your link status\n` +
            `/settings — Manage your features\n` +
            `/unlink — Disconnect your WhatsApp\n` +
            `/help — Show this menu`,
            { parse_mode: "Markdown" }
        );
    });

    // ── /link ─────────────────────────────────────────────────────────
    bot.command("link", async (ctx) => {
        const chatId = ctx.chat.id;
        userState.set(chatId, { stage: "awaiting_phone" });

        await ctx.reply(
            `📱 *Link Your WhatsApp*\n\n` +
            `Send me your WhatsApp number with country code.\n\n` +
            `*Example:* \`2348103077073\`\n` +
            `_(no spaces, no +, no dashes)_`,
            { parse_mode: "Markdown" }
        );
    });

    // ── /status ───────────────────────────────────────────────────────
    bot.command("status", async (ctx) => {
        const chatId = ctx.chat.id;
        const state = userState.get(chatId);

        if (!state?.sessionId) {
            await ctx.reply(
                `❌ You don't have a linked number yet.\n\nUse /link to get started.`
            );
            return;
        }

        const session = getSessionState(state.sessionId);
        if (!session) {
            await ctx.reply(`❌ Session not found. Try /link again.`);
            return;
        }

        const icon = session.status === "connected" ? "✅" : "⚠️";
        await ctx.reply(
            `${icon} *Status:* ${session.status}\n` +
            `📱 *Phone:* +${session.phoneNumber ?? state.phone ?? "unknown"}\n` +
            `🆔 *Session:* \`${state.sessionId}\``,
            { parse_mode: "Markdown" }
        );
    });

    // ── /settings ─────────────────────────────────────────────────────
    bot.command("settings", async (ctx) => {
        await ctx.reply("🔧 Coming in Phase 3 — settings menu.");
    });

    // ── /unlink ───────────────────────────────────────────────────────
    bot.command("unlink", async (ctx) => {
        const chatId = ctx.chat.id;
        const state = userState.get(chatId);

        if (!state?.sessionId) {
            await ctx.reply(`❌ Nothing to unlink.`);
            return;
        }

        try {
            deleteSession(state.sessionId);
            userState.delete(chatId);
            await ctx.reply(`✅ WhatsApp unlinked.`);
        } catch (e) {
            await ctx.reply(`❌ Failed: ${(e as Error).message}`);
        }
    });

    // ── Handle text messages (phone number + choices) ────────────────
    bot.on("message:text", async (ctx) => {
        const chatId = ctx.chat.id;
        const text = ctx.message.text.trim();
        const state = userState.get(chatId);

        if (!state) return; // ignore unhandled text

        // Step 1: User sends phone number
        if (state.stage === "awaiting_phone") {
            const cleanPhone = text.replace(/\D/g, "");

            if (cleanPhone.length < 10) {
                await ctx.reply(
                    `❌ Invalid number. Send it like: \`2348103077073\`\n_(digits only, with country code)_`,
                    { parse_mode: "Markdown" }
                );
                return;
            }

            state.phone = cleanPhone;
            state.sessionId = `user_${cleanPhone}`;
            state.stage = "awaiting_choice";
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

    // ── Handle button clicks ──────────────────────────────────────────
    bot.on("callback_query:data", async (ctx) => {
        const data = ctx.callbackQuery.data;
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        const [action, phone] = data.split(":");
        const sessionId = `user_${phone}`;

        await ctx.answerCallbackQuery(); // remove loading spinner

        try {
            // Start the WhatsApp session
            startSession(sessionId, `+${phone}`).catch((err) => {
                console.error(`Session ${sessionId} start error:`, err);
            });

            // Wait for session to initialize
            await new Promise((r) => setTimeout(r, 3000));

            const session = getSessionState(sessionId);
            if (!session) {
                await ctx.reply(`❌ Failed to start session. Try again.`);
                return;
            }

            if (action === "qr") {
                if (!session.qrDataUrl) {
                    await ctx.reply(`⚠️ QR not ready yet. Wait 10 seconds and try again.`);
                    return;
                }
                // Convert data URL to buffer
                const base64 = session.qrDataUrl.split(",")[1];
                const buffer = Buffer.from(base64, "base64");
                await ctx.replyWithPhoto(
                    { source: buffer },
                    {
                        caption:
                            `🔳 *Scan this QR code*\n\n` +
                            `WhatsApp → Settings → Linked Devices → Link a Device`,
                        parse_mode: "Markdown",
                    }
                );
            } else if (action === "pair") {
                try {
                    const code = await requestPairingCode(sessionId, phone);
                    await ctx.reply(
                        `🔢 *Pairing Code*\n\n` +
                        `\`${code}\`\n\n` +
                        `WhatsApp → Settings → Linked Devices → Link with Phone Number\n\n` +
                        `_Enter the code above when prompted._`,
                        { parse_mode: "Markdown" }
                    );
                } catch (e) {
                    await ctx.reply(`❌ Failed to get pairing code: ${(e as Error).message}`);
                }
            }

            // Clear stage after successful flow
            const state = userState.get(chatId);
            if (state) {
                state.stage = undefined;
                userState.set(chatId, state);
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