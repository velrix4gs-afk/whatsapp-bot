import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import { downloadContentFromMessage, toBuffer } from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import type { BotSettings } from "../settings";

const MEDIA_DIR = path.join(process.cwd(), "data", "saved_media");

function mimeToExt(mime: string | null | undefined): string {
  if (!mime) return "bin";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("mp4") || mime.includes("video")) return "mp4";
  if (mime.includes("webp")) return "webp";
  return "bin";
}

export async function handleStatusReaction(
  sock: WASocket,
  msg: WAMessage,
  settings: BotSettings,
  addLog: (s: string) => void
): Promise<void> {
  if (!msg.key.participant) return;
  const pool = settings.reactionEmojis;
  if (!pool.length) return;
  const emoji = pool[Math.floor(Math.random() * pool.length)];
  try {
    await sock.sendMessage(msg.key.participant, {
      react: { text: emoji, key: msg.key },
    });
    addLog(`Reacted ${emoji} to status from ${msg.key.participant}`);
  } catch (err) {
    addLog(`Status react failed: ${(err as Error).message}`);
  }
}

export async function handleStatusDownload(
  msg: WAMessage,
  sessionId: string,
  addSavedFile: (f: string) => void,
  addLog: (s: string) => void
): Promise<void> {
  const inner = msg.message as Record<string, unknown>;
  const imageMsg = inner["imageMessage"] as { url?: string; directPath?: string; mediaKey?: Uint8Array; mimetype?: string } | undefined;
  const videoMsg = inner["videoMessage"] as { url?: string; directPath?: string; mediaKey?: Uint8Array; mimetype?: string } | undefined;
  const mediaMsg = imageMsg ?? videoMsg;
  if (!mediaMsg) return;

  const mediaType = imageMsg ? "image" : "video";
  try {
    const stream = await downloadContentFromMessage(mediaMsg, mediaType);
    const buffer = await toBuffer(stream);
    const ext = mimeToExt(mediaMsg.mimetype);
    const filename = `status_${sessionId}_${Date.now()}.${ext}`;
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
    addSavedFile(filename);
    addLog(`Auto-saved status ${mediaType}: ${filename}`);
  } catch (err) {
    addLog(`Status download failed: ${(err as Error).message}`);
  }
}
