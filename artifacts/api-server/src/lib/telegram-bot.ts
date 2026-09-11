import { createRequire } from "module";
const require = createRequire(import.meta.url);
const TelegramBot = require("node-telegram-bot-api");

let bot: any = null;

export function startTelegramBot(): void {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.warn("⚠️ TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
        return;
    }

    bot = new TelegramBot(token, { polling: true });

    bot.on("polling_error", (err) => {
        console.error("Telegram polling error:", err.message);
    });

    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const name = msg.from?.first_name ?? "there";
        bot!.sendMessage(
            chatId,
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

    bot.onText(/\/help/, (msg) => {
        bot!.sendMessage(
            msg.chat.id,
            `📖 *Available Commands*\n\n` +
            `/link — Link your WhatsApp number\n` +
            `/status — Check your link status\n` +
            `/settings — Manage your features\n` +
            `/unlink — Disconnect your WhatsApp\n` +
            `/help — Show this menu`,
            { parse_mode: "Markdown" }
        );
    });

    // Placeholder — we'll build these in Phase 2
    bot.onText(/\/link/, (msg) => {
        bot!.sendMessage(msg.chat.id, "🔧 Coming in Phase 2 — phone linking.");
    });

    bot.onText(/\/status/, (msg) => {
        bot!.sendMessage(msg.chat.id, "🔧 Coming in Phase 2 — status check.");
    });

    bot.onText(/\/settings/, (msg) => {
        bot!.sendMessage(msg.chat.id, "🔧 Coming in Phase 3 — settings menu.");
    });

    bot.onText(/\/unlink/, (msg) => {
        bot!.sendMessage(msg.chat.id, "🔧 Coming in Phase 2 — unlink.");
    });

    console.log("✅ Telegram bot started (@nova_wa_bot)");
}

export function getBot(): TelegramBot | null {
    return bot;
}