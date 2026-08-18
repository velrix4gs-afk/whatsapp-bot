import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import type { KeywordReply } from "../settings";

export async function handleKeywordReply(
  sock: WASocket,
  msg: WAMessage,
  sender: string,
  keywords: KeywordReply[],
  addLog: (s: string) => void
): Promise<boolean> {
  if (!keywords.length) return false;

  const text =
    (msg.message?.conversation ??
     msg.message?.extendedTextMessage?.text ?? "").trim().toLowerCase();

  if (!text) return false;

  for (const kw of keywords) {
    const needle = kw.keyword.toLowerCase();
    const matched =
      kw.matchType === "exact" ? text === needle : text.includes(needle);

    if (matched) {
      try {
        await sock.sendMessage(sender, { text: kw.reply }, { quoted: msg });
        addLog(`Keyword "${kw.keyword}" matched → replied`);
      } catch (err) {
        addLog(`Keyword reply failed: ${(err as Error).message}`);
      }
      return true;
    }
  }
  return false;
}
