import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import { downloadContentFromMessage, toBuffer } from "@whiskeysockets/baileys";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";

const execFileAsync = promisify(execFile);

async function imageToSticker(buffer: Buffer): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(buffer)
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 80 })
    .toBuffer();
}

async function videoToSticker(buffer: Buffer): Promise<Buffer> {
  const tmpIn  = path.join(os.tmpdir(), `sticker_in_${Date.now()}.mp4`);
  const tmpOut = path.join(os.tmpdir(), `sticker_out_${Date.now()}.webp`);
  fs.writeFileSync(tmpIn, buffer);
  try {
    await execFileAsync("ffmpeg", [
      "-i", tmpIn,
      "-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,fps=15",
      "-c:v", "libwebp",
      "-lossless", "0",
      "-q:v", "70",
      "-loop", "0",
      "-preset", "default",
      "-an",
      "-vsync", "0",
      "-t", "5",
      tmpOut,
    ]);
    return fs.readFileSync(tmpOut);
  } finally {
    fs.rmSync(tmpIn, { force: true });
    fs.rmSync(tmpOut, { force: true });
  }
}

export async function handleSticker(
  sock: WASocket,
  msg: WAMessage,
  sender: string,
  addLog: (s: string) => void
): Promise<void> {
  // Accept: message with #sticker caption, or reply to image/video with #sticker
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const direct = msg.message;

  const imageMsg =
    quoted?.["imageMessage"] as { url?: string; directPath?: string; mediaKey?: Uint8Array; mimetype?: string } | undefined ??
    direct?.imageMessage as { url?: string; directPath?: string; mediaKey?: Uint8Array; mimetype?: string } | undefined;

  const videoMsg =
    quoted?.["videoMessage"] as { url?: string; directPath?: string; mediaKey?: Uint8Array; mimetype?: string } | undefined ??
    direct?.videoMessage as { url?: string; directPath?: string; mediaKey?: Uint8Array; mimetype?: string } | undefined;

  if (!imageMsg && !videoMsg) {
    await sock.sendMessage(sender, {
      text: "Send an image or video with the caption *#sticker*, or reply to one with *#sticker*.",
    });
    return;
  }

  const mediaMsg = imageMsg ?? videoMsg!;
  const mediaType = imageMsg ? "image" : "video";

  try {
    addLog(`Creating sticker (${mediaType}) for ${sender}…`);
    const stream = await downloadContentFromMessage(mediaMsg, mediaType);
    const buffer = await toBuffer(stream);

    const stickerBuffer = mediaType === "image"
      ? await imageToSticker(buffer)
      : await videoToSticker(buffer);

    await sock.sendMessage(sender, {
      sticker: stickerBuffer,
    });
    addLog(`Sticker sent to ${sender}`);
  } catch (err) {
    addLog(`Sticker failed: ${(err as Error).message}`);
    await sock.sendMessage(sender, {
      text: `❌ Could not create sticker: ${(err as Error).message}`,
    });
  }
}
