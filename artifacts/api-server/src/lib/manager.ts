import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { EventEmitter } from "events";

export interface WorkerInfo {
    sessionId: string;
    phone?: string;
    status: "starting" | "qr" | "connecting" | "connected" | "disconnected";
    qrDataUrl?: string;
    pairingCode?: string;
    phoneNumber?: string | null;
    registered: boolean;
    error?: string;
    process: ChildProcess;
    killedByUser?: boolean;
    loggedOut?: boolean;
    restartCount: number;
    spawnedAt: number;
}

/** Shape sent to the browser — never includes the live ChildProcess (not JSON-safe). */
export interface PublicWorkerInfo {
    id: string;
    label: string;
    status: WorkerInfo["status"];
    qrDataUrl?: string;
    pairingCode?: string;
    phoneNumber?: string | null;
    registered: boolean;
    error?: string;
}

export const workerEvents = new EventEmitter();
const workers = new Map<string, WorkerInfo>();
const restartTimers = new Map<string, NodeJS.Timeout>();

const WORKER_PATH = path.join(process.cwd(), "src", "worker.ts");
const SESSIONS_DIR = path.join(process.cwd(), "data", "sessions");
const REGISTRY_PATH = path.join(SESSIONS_DIR, "index.json");

interface KnownSession { id: string; phone?: string }

function readKnown(): KnownSession[] {
    try {
        const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
        if (!Array.isArray(raw)) return [];
        return raw.filter((s: any) => s && typeof s.id === "string");
    } catch { return []; }
}

function writeKnown(list: KnownSession[]): void {
    try {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        fs.writeFileSync(REGISTRY_PATH, JSON.stringify(list, null, 2));
    } catch (e) {
        console.log(`⚠️ Could not save session registry: ${e}`);
    }
}

/** Remember every linked/attempted session so multiple users survive a restart. */
export function rememberSession(id: string, phone?: string): void {
    if (!id) return;
    const list = readKnown();
    const found = list.find((s) => s.id === id);
    if (found) {
        if (phone && !found.phone) { found.phone = phone; writeKnown(list); }
        return;
    }
    list.push({ id, phone: phone || undefined });
    writeKnown(list);
}

export function forgetKnownSession(id: string): void {
    writeKnown(readKnown().filter((s) => s.id !== id));
}

export function sessionAuthDir(id: string): string {
    return path.join(SESSIONS_DIR, id, "auth");
}

/** True when this session has credentials on disk (i.e. was linked at some point). */
export function hasSavedCreds(id: string): boolean {
    return fs.existsSync(path.join(sessionAuthDir(id), "creds.json"));
}

/** Remove half-written credentials so a failed pairing doesn't poison the retry. */
export function wipeSessionAuth(id: string): void {
    try { fs.rmSync(sessionAuthDir(id), { recursive: true, force: true }); } catch { }
}

/** Full removal of a session's local data (auth, media, memory) — used by Delete. */
export function removeSessionData(id: string): void {
    try { fs.rmSync(path.join(SESSIONS_DIR, id), { recursive: true, force: true }); } catch { }
}

/** Auto-launch workers for sessions that were linked before this process started. */
export function resumeKnownSessions(): void {
    for (const s of readKnown()) {
        if (!fs.existsSync(path.join(sessionAuthDir(s.id), "creds.json"))) continue;
        if (workers.has(s.id)) continue;
        try {
            spawnWorker(s.id, s.phone);
            console.log(`🔁 Resuming session ${s.id}`);
        } catch (e) {
            console.log(`⚠️ Could not resume ${s.id}: ${e}`);
        }
    }
}

function isAlive(info: WorkerInfo): boolean {
    return !info.killedByUser && info.process.exitCode === null && !info.process.killed;
}

/**
 * Spawn (or reuse) the worker for a session.
 *
 * The old implementation killed and respawned on every call, which is what made
 * repeated "link" clicks pile up worker processes. Now an already-running
 * worker is reused unless `force` is set.
 */
export function spawnWorker(sessionId: string, phone?: string, opts: { force?: boolean } = {}): WorkerInfo {
    const existing = workers.get(sessionId);
    if (existing && !opts.force && isAlive(existing)) {
        if (phone && !existing.phone) existing.phone = phone;
        return existing;
    }
    if (existing) killWorker(sessionId);

    const timer = restartTimers.get(sessionId);
    if (timer) { clearTimeout(timer); restartTimers.delete(sessionId); }

    const child = spawn(process.execPath, ["--import", "tsx", WORKER_PATH], {
        cwd: process.cwd(),
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: { ...process.env, WORKER_SESSION_ID: sessionId, WORKER_PHONE: phone || "" },
    });

    const info: WorkerInfo = {
        sessionId,
        phone,
        status: "starting",
        registered: false,
        process: child,
        restartCount: 0,
        spawnedAt: Date.now(),
    };
    workers.set(sessionId, info);
    rememberSession(sessionId, phone);
    console.log(`🟢 Worker spawned: ${sessionId} (pid ${child.pid})`);

    child.on("message", (msg: any) => {
        if (!msg || typeof msg !== "object") return;
        if (workers.get(sessionId) !== info) return;

        switch (msg.type) {
            case "started":
                info.status = "connecting";
                info.registered = !!msg.registered;
                break;
            case "qr":
                info.status = "qr";
                info.pairingCode = undefined;
                import("qrcode").then(({ default: QRCode }) =>
                    QRCode.toDataURL(msg.qr, { width: 320 }).then((url) => {
                        if (workers.get(sessionId) !== info) return;
                        info.qrDataUrl = url;
                        workerEvents.emit(`qr:${sessionId}`, url);
                    })
                ).catch(() => { });
                break;
            case "pairing":
                info.pairingCode = msg.code;
                info.error = undefined;
                workerEvents.emit(`pairing:${sessionId}`, msg.code);
                break;
            case "pairing_error":
                info.pairingCode = undefined;
                info.error = String(msg.error || "Pairing failed — request a new code");
                workerEvents.emit(`pairing_error:${sessionId}`, msg.error);
                break;
            case "connected":
                info.status = "connected";
                info.registered = true;
                info.error = undefined;
                info.phoneNumber = msg.phoneNumber;
                info.qrDataUrl = undefined;
                info.pairingCode = undefined;
                info.restartCount = 0;
                workerEvents.emit(`connected:${sessionId}`, msg.phoneNumber);
                break;
            case "disconnected":
                info.status = "disconnected";
                break;
            case "logged_out":
                info.status = "disconnected";
                info.pairingCode = undefined;
                info.qrDataUrl = undefined;
                info.loggedOut = true;
                info.error = "Logged out of WhatsApp — link this number again";
                break;
            case "error":
                info.error = String(msg.error || "Unknown worker error");
                workerEvents.emit(`error:${sessionId}`, msg.error);
                break;
        }
    });

    child.on("exit", (code) => {
        if (workers.get(sessionId) !== info) return;
        if (info.killedByUser) { workers.delete(sessionId); return; }

        info.status = "disconnected";
        if (info.loggedOut) {
            // Keep the card so the UI can explain what happened; a fresh link starts via Reset.
            return;
        }

        info.restartCount++;
        if (info.restartCount > 5) {
            info.error = `Worker kept crashing (code ${code}) — press Restart to retry`;
            return;
        }
        info.error = info.error ?? `Worker crashed (code ${code}) — restarting…`;

        const delay = Math.min(3000 * info.restartCount, 30000);
        const t = setTimeout(() => {
            restartTimers.delete(sessionId);
            if (workers.get(sessionId) !== info) return;
            spawnWorker(sessionId, info.phone, { force: true });
        }, delay);
        restartTimers.set(sessionId, t);
    });

    return info;
}

export function killWorker(sessionId: string): void {
    const w = workers.get(sessionId);
    const t = restartTimers.get(sessionId);
    if (t) { clearTimeout(t); restartTimers.delete(sessionId); }
    if (!w) return;

    w.killedByUser = true;
    w.status = "disconnected";
    try { if (w.process.connected && w.process.send) w.process.send({ type: "kill" }); } catch { }
    try { w.process.kill("SIGKILL"); } catch { }
    workers.delete(sessionId);
}

export function getWorker(sessionId: string): WorkerInfo | undefined {
    return workers.get(sessionId);
}

export function getAllWorkers(): WorkerInfo[] {
    return Array.from(workers.values());
}

export function toPublicWorker(w: WorkerInfo): PublicWorkerInfo {
    return {
        id: w.sessionId,
        label: w.phone || w.sessionId,
        status: w.status,
        qrDataUrl: w.qrDataUrl,
        pairingCode: w.pairingCode,
        phoneNumber: w.phoneNumber,
        registered: w.registered,
        error: w.error,
    };
}
