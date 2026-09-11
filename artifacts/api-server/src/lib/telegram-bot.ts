import { Bot } from "grammy";

let bot: Bot | null = null;

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
            `/settings — Manage your features\n` +
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
            `/settings — Manage your features\n` +
            `/unlink — Disconnect your WhatsApp\n` +
            `/help — Show this menu`,
            { parse_mode: "Markdown" }
        );
    });

    bot.command("link", async (ctx) => {
        await ctx.reply("🔧 Coming in Phase 2 — phone linking.");
    });

    bot.command("status", async (ctx) => {
        await ctx.reply("🔧 Coming in Phase 2 — status check.");
    });

    bot.command("settings", async (ctx) => {
        await ctx.reply("🔧 Coming in Phase 3 — settings menu.");
    });

    bot.command("unlink", async (ctx) => {
        await ctx.reply("🔧 Coming in Phase 2 — unlink.");
    });

    bot.catch((err) => {
        console.error("Telegram bot error:", err);
    });

    // Start polling (non-blocking)
    bot.start({
        onStart: () => console.log("✅ Telegram bot started (@nova_wa_bot)"),
    });
}

export function getBot(): Bot | null {
    return bot;
}