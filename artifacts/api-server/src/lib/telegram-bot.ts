import { Bot, InlineKeyboard, InputFile } from "grammy";
import {
    spawnWorker,
    killWorker,
    getWorker,
    getAllWorkers,
} from "./manager";

let bot: Bot | null = null;

const userState = new Map<number, {
    phone?: string;
    sessionId?: string;
    stage?: "awaiting_phone";
}>();

function watchAndDeleteOnConnect(
    sessionId: string,
    chatId: number,
    messageId: number,
    successMsg: string
) {
    let tries = 0;
    const interval = setInterval(async () => {
        tries++;
        if (tries > 100) { clearInterval(interval); return; }

        const w = getWorker(sessionId);
        if (!w) return;

        if (w.status === "connected") {
            clearInterval(interval);
            try { await bot!.api.deleteMessage(chatId, messageId); } catch { }
            try {
                await bot!.api.sendMessage(chatId, successMsg, { parse_mode: "Markdown" });
            } catch { }
        }
    }, 3000);
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

        if (w.pairingCode && w.status !== "connected") {
            msg += `\n\n🔢 *Pairing code:* \`${w.pairingCode}\``;
        }

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

    // Phone number input
    bot.on("message:text", async (ctx) => {
        const chatId = ctx.chat.id;
        const text = ctx.message.text.trim();
        const state = userState.get(chatId);
        if (!state || state.stage !== "awaiting_phone") return;

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

            if (action === "qr") {
                spawnWorker(sessionId);
                await new Promise((r) => setTimeout(r, 6000));

                const w = getWorker(sessionId);
                if (!w?.qrDataUrl) {
                    await ctx.reply(`⚠️ QR not ready. Wait 5 seconds and try again.`);
                    return;
                }

                const base64 = w.qrDataUrl.split(",")[1];
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
                    `✅ *WhatsApp linked successfully!*\n\nYou can now use the bot from +${phone}.`
                );
            } else if (action === "pair") {
                spawnWorker(sessionId, phone);
                await new Promise((r) => setTimeout(r, 3000));

                const w = getWorker(sessionId);
                const code = w?.pairingCode;

                if (!code) {
                    await ctx.reply(
                        `⚠️ Pairing code not ready.\n\nTry again in 3 seconds, or use /status.`
                    );
                    return;
                }

                const sent = await ctx.reply(
                    `🔢 *Pairing Code*\n\n` +
                    `\`${code}\`\n\n` +
                    `WhatsApp → Settings → Linked Devices → Link with Phone Number\n\n` +
                    `_Enter this code FAST — it expires in ~20 seconds._`,
                    { parse_mode: "Markdown" }
                );

                watchAndDeleteOnConnect(
                    sessionId,
                    chatId,
                    sent.message_id,
                    `✅ *WhatsApp linked successfully!*\n\nYou can now use the bot from +${phone}.`
                );
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