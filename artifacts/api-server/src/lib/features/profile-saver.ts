import type { WASocket } from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import os from "os";

const MEDIA_DIR = path.join(process.cwd(), "data", "saved_media");

/**
 * Fetch and send a profile picture.
 * @param jid       - JID whose picture to fetch
 * @param dmJid     - JID to SEND the result to (always the requester's private DM)
 * @param groupJid  - Optional group JID to reply "check your DM" in
 */
export async function saveProfilePicture(
  sock: WASocket,
  jid: string,
  dmJid: string,
  groupJid: string | null,
  label: string,
  addSavedFile: (f: string) => void,
  addLog: (s: string) => void
): Promise<void> {
  try {
    addLog(`Fetching profile picture for ${label}…`);
    const url = await sock.profilePictureUrl(jid, "image");
    if (!url) {
      await sock.sendMessage(dmJid, { text: `No profile picture found for ${label}.` });
      return;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer   = Buffer.from(await res.arrayBuffer());
    const filename = `profile_${label.replace(/\+/g, "")}_${Date.now()}.jpg`;
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
    addSavedFile(filename);
    addLog(`Saved profile picture for ${label}`);

    // Send to requester's private DM
    await sock.sendMessage(dmJid, { image: buffer, caption: `📸 Profile picture for ${label}` });

    // If the command was used in a group, notify there too (brief)
    if (groupJid && groupJid !== dmJid) {
      await sock.sendMessage(groupJid, { text: `📸 Sent ${label}'s profile picture to your DM!` });
    }
  } catch (err) {
    const msg = (err as Error).message;
    addLog(`Profile fetch failed for ${label}: ${msg}`);
    await sock.sendMessage(dmJid, { text: `Could not get profile picture for ${label}: ${msg}` });
  }
}

/**
 * Save and forward a status photo/video to the requester's private DM.
 */
export async function handleSaveStatusMedia(
  sock: WASocket,
  contextInfo: { quotedMessage?: Record<string, unknown> } | null | undefined,
  dmJid: string,
  groupJid: string | null,
  addSavedFile: (f: string) => void,
  addLog: (s: string) => void
): Promise<void> {
  if (!contextInfo?.quotedMessage) {
    await sock.sendMessage(dmJid, { text: 'Reply to a status with ".save" to save it.' });
    return;
  }
  const { downloadContentFromMessage, toBuffer } = await import("@whiskeysockets/baileys");
  const quoted   = contextInfo.quotedMessage as Record<string, unknown>;
  const imageMsg = quoted["imageMessage"] as { url?: string; directPath?: string; mediaKey?: Uint8Array; mimetype?: string } | undefined;
  const videoMsg = quoted["videoMessage"] as { url?: string; directPath?: string; mediaKey?: Uint8Array; mimetype?: string } | undefined;
  const mediaMsg = imageMsg ?? videoMsg;
  if (!mediaMsg) {
    await sock.sendMessage(dmJid, { text: "Nothing to save — the status has no photo or video." });
    return;
  }
  const mediaType = imageMsg ? "image" : "video";
  try {
    const stream   = await downloadContentFromMessage(mediaMsg, mediaType);
    const buffer   = await toBuffer(stream);
    const ext      = mediaMsg.mimetype?.includes("mp4") ? "mp4" : "jpg";
    const filename = `status_${Date.now()}.${ext}`;
    const dir      = path.join(os.homedir(), ".whatsapp-bot", "saved_media");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), buffer);
    addSavedFile(filename);
    addLog(`Saved status ${mediaType}: ${filename}`);

    // Send media to private DM
    if (mediaType === "image") {
      await sock.sendMessage(dmJid, { image: buffer, caption: "💾 Saved status photo." });
    } else {
      await sock.sendMessage(dmJid, { video: buffer, caption: "💾 Saved status video." });
    }

    // Notify in group/original chat if different
    if (groupJid && groupJid !== dmJid) {
      await sock.sendMessage(groupJid, { text: "💾 Status saved — check your DM!" });
    }
  } catch (err) {
    addLog(`Status save failed: ${(err as Error).message}`);
    await sock.sendMessage(dmJid, { text: `Could not save: ${(err as Error).message}` });
  }
}
