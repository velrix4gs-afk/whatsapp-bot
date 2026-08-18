import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import type { BotSettings } from "../settings";

const URL_RE = /https?:\/\/[^\s]+|wa\.me\/[^\s]+|chat\.whatsapp\.com\/[^\s]+/i;

export async function handleAntiLink(
  sock: WASocket,
  msg: WAMessage,
  sender: string,
  groupJid: string,
  settings: BotSettings,
  addLog: (s: string) => void
): Promise<boolean> {
  const text =
    msg.message?.conversation ??
    msg.message?.extendedTextMessage?.text ?? "";

  if (!URL_RE.test(text)) return false;

  // Check whitelist
  const whitelist = settings.antiLinkWhitelist ?? [];
  const hasWhitelisted = whitelist.some((domain) => text.includes(domain));
  if (hasWhitelisted) return false;

  const participant = msg.key.participant ?? sender;

  try {
    // Delete the message
    await sock.sendMessage(groupJid, { delete: msg.key });
    // Warn the user
    await sock.sendMessage(groupJid, {
      text: `⛔ @${participant.split("@")[0]}, links are not allowed in this group.`,
      mentions: [participant],
    });
    addLog(`Anti-link: removed message from ${participant} in ${groupJid}`);
    return true;
  } catch (err) {
    addLog(`Anti-link action failed: ${(err as Error).message}`);
    return false;
  }
}

export async function handleGroupParticipantUpdate(
  sock: WASocket,
  groupJid: string,
  participants: string[],
  action: "add" | "remove" | "promote" | "demote",
  settings: BotSettings,
  addLog: (s: string) => void
): Promise<void> {
  if (!settings.features.welcomeGoodbye) return;
  if (action !== "add" && action !== "remove") return;

  for (const participant of participants) {
    const tag = `@${participant.split("@")[0]}`;
    const text =
      action === "add"
        ? (settings.welcomeMessage || `👋 Welcome ${tag}! Glad to have you here.`)
        : (settings.goodbyeMessage || `👋 ${tag} has left the group. Goodbye!`);

    try {
      await sock.sendMessage(groupJid, { text, mentions: [participant] });
      addLog(`${action === "add" ? "Welcome" : "Goodbye"} sent for ${participant}`);
    } catch (err) {
      addLog(`Welcome/goodbye send failed: ${(err as Error).message}`);
    }
  }
}
