/**
 * Worker – runs ONE WhatsApp session as a child process.
 */
import makeWASocket, {
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import pino from "pino";

const SESSION_ID = process.env.WORKER_SESSION_ID || "";
const PAIRING_PHONE = process.env.WORKER_PHONE || "";

if (!SESSION_ID) {
    console.error("Worker: missing WORKER_SESSION_ID");
    process.exit(1);
}

const BASE_DIR = path.join(process.cwd(), "data");
const AUTH_DIR = path.join(BASE_DIR, "sessions", SESSION_ID, "auth");
fs.mkdirSync(AUTH_DIR, { recursive: true });

function ipc(msg: any) {
    try {
        if (process.send && process.connected) process.send(msg);
    } catch { /* ignore closed channel */ }
}

function log(text: string) {
    console.log(`[${SESSION_ID}] ${text}`);
    ipc({ type: "log", text });
}

let pairingRequested = false;
let sock: any = null;
let stopping = false;

async function run() {
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const logger = pino({ level: "silent" });
    sock = makeWASocket({
        version,
        auth: {
            creds: authState.creds,
            keys: makeCacheableSignalKeyStore(authState.keys, logger),
        },
        browser: Browsers.ubuntu(`NovaBot-${SESSION_ID}`),
        printQRInTerminal: false,
        syncFullHistory: false,
        connectTimeoutMs: 30_000,
        keepAliveIntervalMs: 10_000,
        logger,
        getMessage: async () => ({ conversation: "" }),
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            ipc({ type: "qr", qr });

            if (PAIRING_PHONE && !pairingRequested && !authState.creds.registered) {
                pairingRequested = true;
                try {
                    const cleanPhone = PAIRING_PHONE.replace(/\D/g, "");
                    const code = await sock.requestPairingCode(cleanPhone);
                    ipc({ type: "pairing", code });
                    log(`Pairing code: ${code}`);
                } catch (e) {
                    ipc({ type: "pairing_error", error: (e as Error).message });
                    pairingRequested = false;
                }
            }
        }

        if (connection === "open") {
            const phoneNumber = sock.user?.id?.split(":")[0];
            ipc({ type: "connected", phoneNumber });
            log(`✅ Connected as +${phoneNumber}`);
        }

        if (connection === "close") {
            const err = lastDisconnect?.error as Boom | undefined;
            const code = err?.output?.statusCode ?? 0;

            ipc({ type: "disconnected", code });

            if (stopping) return;

            if (pairingRequested && !authState.creds.registered) {
                log("Socket closed during pairing — not reconnecting");
                return;
            }

            if (code === DisconnectReason.loggedOut) {
                log("Logged out — clearing auth");
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                fs.mkdirSync(AUTH_DIR, { recursive: true });
                ipc({ type: "logged_out" });
                return;
            }

            setTimeout(() => run().catch(() => { }), 3000);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }: any) => {
        for (const msg of messages) {
            if (!msg.message) continue;
            const chatJid = msg.key.remoteJid || "";
            if (chatJid === "status@broadcast") continue;

            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                "";
            if (!text) continue;

            const cmd = text.trim().toLowerCase().replace(/^\./, "");

            if (cmd === "ping") {
                try {
                    await sock.sendMessage(chatJid, { text: "🏓 Pong!" });
                    log(`Pong to ${chatJid}`);
                } catch (e) {
                    log(`Pong failed: ${(e as Error).message}`);
                }
            }
        }
    });

    ipc({ type: "started", sessionId: SESSION_ID });
}

// 🔑 KEY FIX: keep the process alive forever
const keepAlive = setInterval(() => {
    // This empty interval prevents Node from exiting
}, 30_000);

// Handle kill from parent
process.on("message", (msg: any) => {
    if (msg?.type === "kill") {
        stopping = true;
        clearInterval(keepAlive);
        try { sock?.end(undefined); } catch { }
        setTimeout(() => process.exit(0), 500);
    }
});

process.on("SIGTERM", () => {
    clearInterval(keepAlive);
    process.exit(0);
});

process.on("SIGINT", () => {
    clearInterval(keepAlive);
    process.exit(0);
});

// Start the bot
run().catch((err) => {
    console.error(`[${SESSION_ID}] Worker crashed:`, err);
    ipc({ type: "error", error: (err as Error).message });
    // Don't exit — keepAlive will keep it running
});