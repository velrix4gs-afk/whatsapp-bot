import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./lib/whatsapp-bot";
import { startHeartbeat } from "./lib/heartbeat";
import { initSettings, loadSessionsFromDb } from "./lib/settings";

// ── Crash protection: log but never die ──────────────────────────────────────
process.on("uncaughtException", (err) => {
  logger.error({ err: err.message, stack: err.stack }, "Uncaught exception — keeping server alive");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ reason: String(reason) }, "Unhandled rejection — keeping server alive");
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Restore persisted settings + sessions from DB before accepting bot traffic
  try { await initSettings(); } catch (e) { logger.warn({ err: String(e) }, "initSettings failed — using defaults"); }
  try { await loadSessionsFromDb(); } catch (e) { logger.warn({ err: String(e) }, "loadSessionsFromDb failed — sessions in-memory only"); }

  startBot().catch((e) => logger.error({ err: e }, "WhatsApp bot failed to start"));
  startHeartbeat();
});
