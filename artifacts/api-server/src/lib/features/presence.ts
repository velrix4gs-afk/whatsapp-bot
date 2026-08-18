import type { WASocket } from "@whiskeysockets/baileys";

const REFRESH_INTERVAL_MS = 14_000; // WhatsApp clears typing after ~20s; refresh at 14s

/**
 * Show a sustained typing ("composing") indicator for a given duration.
 * Returns a stop function — call it immediately after the bot sends its reply.
 * The indicator auto-clears when durationMs elapses even if stop() isn't called.
 */
export function startSustainedTyping(
  sock: WASocket,
  jid: string,
  durationMs = 60_000
): () => void {
  let active = true;

  const tick = async () => {
    while (active) {
      sock.sendPresenceUpdate("composing", jid).catch(() => {});
      await new Promise<void>((r) => setTimeout(r, REFRESH_INTERVAL_MS));
    }
  };
  tick().catch(() => {});

  const autoStop = setTimeout(() => {
    if (!active) return;
    active = false;
    sock.sendPresenceUpdate("paused", jid).catch(() => {});
  }, durationMs);

  return () => {
    if (!active) return;
    active = false;
    clearTimeout(autoStop);
    sock.sendPresenceUpdate("paused", jid).catch(() => {});
  };
}

/**
 * Show a "recording…" indicator for a short burst before media replies.
 */
export async function showRecording(sock: WASocket, jid: string, delayMs = 2000): Promise<void> {
  try {
    await sock.sendPresenceUpdate("recording", jid);
    await new Promise<void>((r) => setTimeout(r, delayMs + Math.floor(Math.random() * 1000)));
  } catch { /* ignore */ }
}

/**
 * Clear any presence indicator.
 */
export async function clearPresence(sock: WASocket, jid: string): Promise<void> {
  try {
    await sock.sendPresenceUpdate("paused", jid);
  } catch { /* ignore */ }
}
