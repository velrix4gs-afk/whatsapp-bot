import { logger } from "./logger";

export const SERVER_START_MS = Date.now();
let lastSelfPingMs  = 0;
let lastSelfPingOk  = false;

function getSelfUrl(): string | null {
  // Prefer localhost:PORT — always works since we're on the same machine
  const port = process.env["PORT"];
  if (port) return `http://127.0.0.1:${port}/api/bot/health`;

  // Fallback to public deployment URL (for deployed containers that don't export PORT)
  const dep = process.env["REPLIT_DEPLOYMENT_URL"]
           ?? process.env["REPLIT_DEV_DOMAIN"];
  if (dep) {
    const host = dep.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return `https://${host}/api/bot/health`;
  }
  return null;
}

export function startHeartbeat(intervalMs = 55_000): void {
  const url = getSelfUrl();
  if (!url) {
    logger.warn("Heartbeat: no self URL available, skipping");
    return;
  }
  logger.info({ url, intervalMs }, "Heartbeat started — pinging self to stay alive");

  const tick = async () => {
    try {
      const t0  = Date.now();
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
      lastSelfPingMs  = Date.now();
      lastSelfPingOk  = res.ok;
      if (!res.ok) logger.warn({ status: res.status, ms: Date.now() - t0 }, "Heartbeat self-ping non-200");
    } catch (err) {
      lastSelfPingMs  = Date.now();
      lastSelfPingOk  = false;
      logger.warn({ err: (err as Error).message }, "Heartbeat self-ping failed");
    }
  };

  // Immediate first ping so we know immediately if the server is reachable
  void tick();
  // Then on a regular interval — unref so it doesn't block clean shutdown
  const iv = setInterval(() => void tick(), intervalMs);
  if (iv.unref) iv.unref();
}

export function getHeartbeatInfo(): {
  uptimeSec: number;
  startedAt: string;
  lastSelfPingAgoSec: number | null;
  lastSelfPingOk: boolean;
} {
  return {
    uptimeSec:          Math.floor((Date.now() - SERVER_START_MS) / 1000),
    startedAt:          new Date(SERVER_START_MS).toISOString(),
    lastSelfPingAgoSec: lastSelfPingMs ? Math.floor((Date.now() - lastSelfPingMs) / 1000) : null,
    lastSelfPingOk,
  };
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}
