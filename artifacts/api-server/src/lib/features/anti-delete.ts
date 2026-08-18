import type { WASocket, WAMessage, proto } from "@whiskeysockets/baileys";

const MAX_CACHE = 80;

// chatJid → last N messages
const cache = new Map<string, WAMessage[]>();

export function cacheMessage(msg: WAMessage): void {
  if (!msg.message || !msg.key.remoteJid) return;
  const jid = msg.key.remoteJid;
  const list = cache.get(jid) ?? [];
  list.unshift(msg);
  if (list.length > MAX_CACHE) list.length = MAX_CACHE;
  cache.set(jid, list);
}

export async function handleRevoke(
  sock: WASocket,
  updateMsg: WAMessage,
  addLog: (s: string) => void
): Promise<void> {
  const proto = updateMsg.message?.protocolMessage;
  // type 0 === REVOKE
  if (!proto || proto.type !== 0) return;

  const deletedKey = proto.key;
  if (!deletedKey?.remoteJid || !deletedKey.id) return;

  const chatJid = deletedKey.remoteJid;
  const msgId   = deletedKey.id;

  const cached = (cache.get(chatJid) ?? []).find((m) => m.key.id === msgId);
  if (!cached?.message) {
    addLog(`Anti-delete: message ${msgId} not in cache`);
    return;
  }

  const sender = deletedKey.participant ?? chatJid;
  addLog(`Anti-delete: reposting deleted msg from ${sender}`);

  try {
    const text =
      cached.message.conversation ??
      cached.message.extendedTextMessage?.text ??
      null;

    if (text) {
      await sock.sendMessage(chatJid, {
        text: `🚫 *[Deleted by ${sender}]*\n\n${text}`,
      });
      return;
    }

    const imageMsg = cached.message.imageMessage;
    if (imageMsg) {
      await sock.sendMessage(chatJid, {
        forward: cached,
      });
      return;
    }

    const videoMsg = cached.message.videoMessage;
    if (videoMsg) {
      await sock.sendMessage(chatJid, { forward: cached });
      return;
    }

    // Fallback — just notify
    await sock.sendMessage(chatJid, {
      text: `🚫 *[${sender} deleted a message]*`,
    });
  } catch (err) {
    addLog(`Anti-delete repost failed: ${(err as Error).message}`);
  }
}
