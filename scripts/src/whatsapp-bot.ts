/**
 * WhatsApp Bot using Baileys v7 (multi-device protocol)
 *
 * Features:
 *  - QR code login via terminal
 *  - Auto-likes all incoming status updates from contacts
 *  - #saveprofile <phone_number>  → fetches & sends back the contact's profile picture
 *  - Saves view-once media and replies with the file
 *
 * NOTE: Saving view-once media and auto-reacting to statuses may violate
 * WhatsApp's Terms of Service. Use this for educational/research purposes only.
 *
 * Run:  pnpm --filter @workspace/scripts run whatsapp-bot
 */

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  downloadContentFromMessage,
  toBuffer,
  type WASocket,
  type WAMessage,
  type proto,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAVED_MEDIA_DIR = path.resolve(__dirname, "../../saved_media");
const AUTH_DIR = path.resolve(__dirname, "../../auth_state");

fs.mkdirSync(SAVED_MEDIA_DIR, { recursive: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });

function log(msg: string) {
  console.log(`[WhatsApp Bot] ${new Date().toISOString()} ${msg}`);
}

function mimeToExt(mime: string | null | undefined): string {
  if (!mime) return "bin";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("mp4") || mime.includes("video")) return "mp4";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("ogg") || mime.includes("opus")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("pdf")) return "pdf";
  return "bin";
}

async function startBot(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  log(`Using Baileys version ${version.join(".")}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(
        "\n=== Scan this QR code with WhatsApp > Linked Devices ===\n"
      );
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        log("Connection closed — reconnecting...");
        startBot();
      } else {
        log("Logged out. Delete auth_state/ folder and restart to re-scan QR.");
      }
    } else if (connection === "open") {
      log("Connected to WhatsApp!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const msg of messages) {
      if (!msg.message) continue;

      const sender = msg.key.remoteJid ?? "";
      const isStatus =
        sender === "status@broadcast" || sender.endsWith("@broadcast");

      if (isStatus) {
        await likeStatus(sock, msg);
        continue;
      }

      await handleViewOnce(sock, msg, sender);
      await handleCommands(sock, msg, sender);
    }
  });
}

async function likeStatus(sock: WASocket, msg: WAMessage): Promise<void> {
  try {
    if (!msg.key.id || !msg.key.remoteJid || !msg.key.participant) return;

    await sock.sendMessage(msg.key.participant, {
      react: {
        text: "👍",
        key: msg.key,
      },
    });
    log(`Liked status from ${msg.key.participant}`);
  } catch (err) {
    log(`Failed to like status: ${(err as Error).message}`);
  }
}

async function handleViewOnce(
  sock: WASocket,
  msg: WAMessage,
  sender: string
): Promise<void> {
  const viewOnceMsg =
    msg.message?.viewOnceMessage?.message ??
    msg.message?.viewOnceMessageV2?.message ??
    (msg.message?.viewOnceMessageV2Extension as proto.IMessage | undefined)
      ?.imageMessage
      ? msg.message?.viewOnceMessageV2Extension
      : null;

  const innerMsg =
    (msg.message?.viewOnceMessage?.message as proto.IMessage) ??
    (msg.message?.viewOnceMessageV2?.message as proto.IMessage) ??
    null;

  if (!innerMsg) return;

  const imageMsg = innerMsg.imageMessage ?? null;
  const videoMsg = innerMsg.videoMessage ?? null;
  const audioMsg = innerMsg.audioMessage ?? null;

  const mediaMsg = imageMsg ?? videoMsg ?? audioMsg;
  if (!mediaMsg) return;

  let mediaType: "image" | "video" | "audio";
  if (imageMsg) mediaType = "image";
  else if (videoMsg) mediaType = "video";
  else mediaType = "audio";

  try {
    log(`View-once ${mediaType} received from ${sender} — saving...`);

    const stream = await downloadContentFromMessage(
      mediaMsg as {
        url?: string;
        directPath?: string;
        mediaKey?: Uint8Array;
      },
      mediaType
    );

    const buffer = await toBuffer(stream);

    const mime = (mediaMsg as { mimetype?: string }).mimetype ?? "";
    const ext = mimeToExt(mime);
    const filename = `view-once_${Date.now()}.${ext}`;
    const filepath = path.join(SAVED_MEDIA_DIR, filename);

    fs.writeFileSync(filepath, buffer);
    log(`Saved view-once media → ${filepath}`);

    await sock.sendMessage(sender, {
      text: `Saved your view-once ${mediaType} as: ${filename}`,
    });

    if (mediaType === "image") {
      await sock.sendMessage(sender, {
        image: buffer,
        caption: "Here is your saved view-once image.",
      });
    } else if (mediaType === "video") {
      await sock.sendMessage(sender, {
        video: buffer,
        caption: "Here is your saved view-once video.",
      });
    } else {
      await sock.sendMessage(sender, {
        audio: buffer,
        mimetype: mime || "audio/ogg; codecs=opus",
      });
    }
  } catch (err) {
    log(`Error saving view-once media: ${(err as Error).message}`);
    try {
      await sock.sendMessage(sender, {
        text: `Could not save view-once media: ${(err as Error).message}`,
      });
    } catch {}
  }
}

async function handleCommands(
  sock: WASocket,
  msg: WAMessage,
  sender: string
): Promise<void> {
  const text =
    msg.message?.conversation ??
    msg.message?.extendedTextMessage?.text ??
    "";

  if (!text.startsWith("#saveprofile")) return;

  const parts = text.trim().split(/\s+/);
  const phoneArg = parts[1];

  if (!phoneArg) {
    await sock.sendMessage(sender, {
      text: "Usage: #saveprofile <phone_number>\nExample: #saveprofile 1234567890",
    });
    return;
  }

  const phone = phoneArg.replace(/\D/g, "");
  const jid = `${phone}@s.whatsapp.net`;

  try {
    log(`Fetching profile picture for ${jid}...`);
    const ppUrl = await sock.profilePictureUrl(jid, "image");

    if (!ppUrl) {
      await sock.sendMessage(sender, {
        text: `No profile picture found for +${phone}.`,
      });
      return;
    }

    const res = await fetch(ppUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} from profile picture URL`);

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const filename = `profile_${phone}_${Date.now()}.jpg`;
    const filepath = path.join(SAVED_MEDIA_DIR, filename);
    fs.writeFileSync(filepath, buffer);
    log(`Saved profile picture → ${filepath}`);

    await sock.sendMessage(sender, {
      image: buffer,
      caption: `Profile picture for +${phone} (saved as ${filename})`,
    });
  } catch (err) {
    const errMsg = (err as Error).message;
    log(`Failed to fetch profile picture for ${jid}: ${errMsg}`);
    await sock.sendMessage(sender, {
      text: `Could not fetch profile picture for +${phone}.\nReason: ${errMsg}`,
    });
  }
}

startBot().catch((err) => {
  console.error("[WhatsApp Bot] Fatal error:", err);
  process.exit(1);
});
