import { Bot, InlineKeyboard, InputFile } from "grammy";
import {
    startSession,
    requestPairingCode,
    getSessionState,
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
        let msg =
            `${icon} *Status:* ${session.status}\n` +
            `📱 *Phone:* +${session.phoneNumber ?? state.phone ?? "unknown"}\n` +
            `🆔 *Session:* \`${state.sessionId}\``;

        if (session.pairingCode && session.status !== "connected") {
            msg += `\n\n🔢 *Pairing code:* \`${session.pairingCode}\``;
        }

        await ctx.reply(msg, { parse_mode: "Markdown" });
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

        await ctx.answerCallbackQuery();

        try {
            if (action === "qr") {
                // Start session WITHOUT pairing phone (QR flow)
                startSession(sessionId, `+${phone}`).catch((err) => {
                    console.error(`Session ${sessionId} start error:`, err);
                });

                // Wait for QR to be generated
                await new Promise((r) => setTimeout(r, 3000));

                const session = getSessionState(sessionId);
                if (!session?.qrDataUrl) {
                    await ctx.reply(`⚠️ QR not ready yet. Wait 5 seconds and try again.`);
                    return;
                }

                const base64 = session.qrDataUrl.split(",")[1];
                const buffer = Buffer.from(base64, "base64");

                await ctx.replyWithPhoto(
                    new InputFile(buffer, "qr.png"),
                    {
                        caption:
                            `🔳 *Scan this QR code*\n\n` +
                            `WhatsApp → Settings → Linked Devices → Link a Device`,
                        parse_mode: "Markdown",
                    }
                );
            } else if (action === "pair") {
                // Start session WITH pairing phone (pairing code flow)
                startSession(sessionId, `+${phone}`, phone).catch((err) => {
                    console.error(`Session ${sessionId} start error:`, err);
                });

                // Wait for pairing code
                await new Promise((r) => setTimeout(r, 5000));

                const session = getSessionState(sessionId);
                const code = session?.pairingCode;

                if (!code) {
                    await ctx.reply(`⚠️ Pairing code not ready yet. Wait 5 seconds and try /status, or click again.`);
                    return;
                }

                await ctx.reply(
                    `🔢 *Pairing Code*\n\n` +
                    `\`${code}\`\n\n` +
                    `WhatsApp → Settings → Linked Devices → Link with Phone Number\n\n` +
                    `_Enter the code above when prompted._`,
                    { parse_mode: "Markdown" }
                );
            }

            // Clear stage
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