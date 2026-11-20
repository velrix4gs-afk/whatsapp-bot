import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { EventEmitter } from "events";

export interface WorkerInfo {
    sessionId: string;
    phone?: string;
    status: "starting" | "qr" | "connecting" | "connected" | "disconnected";
    qrDataUrl?: string;
    pairingCode?: string;
    phoneNumber?: string | null;
    process: ChildProcess;
    killedByUser?: boolean;
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
}

export const workerEvents = new EventEmitter();
const workers = new Map<string, WorkerInfo>();
const restartTimers = new Map<string, NodeJS.Timeout>();

const WORKER_PATH = path.join(process.cwd(), "src", "worker.ts");

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
    if (existing && !opts.force) {
        if (isAlive(existing) && existing.status !== "disconnected") {
            console.log(`♻️ Worker already active for ${sessionId} (${existing.status}) — reusing`);
            if (phone && !existing.phone) existing.phone = phone;
            return existing;
        }
        killWorker(sessionId);
    } else if (existing) {
        killWorker(sessionId);
    }

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
        process: child,
        restartCount: existing && opts.force ? 0 : 0,
        spawnedAt: Date.now(),
    };
    workers.set(sessionId, info);
    console.log(`🟢 Worker spawned: ${sessionId} (pid ${child.pid})`);

    child.on("message", (msg: any) => {
        if (!msg || typeof msg !== "object") return;
        if (workers.get(sessionId) !== info) return;

        switch (msg.type) {
            case "started": info.status = "connecting"; break;
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
                workerEvents.emit(`pairing:${sessionId}`, msg.code);
                break;
            case "pairing_error":
                info.pairingCode = undefined;
                workerEvents.emit(`pairing_error:${sessionId}`, msg.error);
                break;
            case "connected":
                info.status = "connected";
                info.phoneNumber = msg.phoneNumber;
                info.qrDataUrl = undefined;
                info.pairingCode = undefined;
                info.restartCount = 0;
                workerEvents.emit(`connected:${sessionId}`, msg.phoneNumber);
                break;
            case "disconnected": info.status = "disconnected"; break;
            case "logged_out":
                info.status = "disconnected";
                info.qrDataUrl = undefined;
                info.pairingCode = undefined;
                info.killedByUser = true; // don't auto-restart a logged-out session
                break;
            case "error":
                workerEvents.emit(`error:${sessionId}`, msg.error);
                break;
        }
    });

    child.on("exit", (code) => {
        if (workers.get(sessionId) !== info) return;
        if (info.killedByUser) { workers.delete(sessionId); return; }

        info.status = "disconnected";
        if (info.pairingCode === undefined && info.phone) {
            workerEvents.emit(`error:${sessionId}`, `Worker crashed (code ${code})`);
        }

        info.restartCount++;
        if (info.restartCount > 5) { workers.delete(sessionId); return; }

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
    };
}
