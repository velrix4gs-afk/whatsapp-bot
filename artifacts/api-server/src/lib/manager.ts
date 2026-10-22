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
}

export const workerEvents = new EventEmitter();
const workers = new Map<string, WorkerInfo>();

const WORKER_PATH = path.join(process.cwd(), "src", "worker.ts");

export function spawnWorker(sessionId: string, phone?: string): WorkerInfo {
    if (workers.has(sessionId)) killWorker(sessionId);

    const child = spawn(process.execPath, ["--import", "tsx", WORKER_PATH], {
        cwd: process.cwd(),
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: { ...process.env, WORKER_SESSION_ID: sessionId, WORKER_PHONE: phone || "" },
    });

    const info: WorkerInfo = { sessionId, phone, status: "starting", process: child, restartCount: 0 };
    workers.set(sessionId, info);
    console.log(`🟢 Worker spawned: ${sessionId} (pid ${child.pid})`);

    child.on("message", (msg: any) => {
        if (!msg || typeof msg !== "object") return;
        if (workers.get(sessionId) !== info) return;

        switch (msg.type) {
            case "started": info.status = "connecting"; break;
            case "qr":
                info.status = "qr";
                import("qrcode").then(({ default: QRCode }) => QRCode.toDataURL(msg.qr, { width: 300 }).then((url) => {
                    info.qrDataUrl = url;
                    workerEvents.emit(`qr:${sessionId}`, url);
                })).catch(() => { });
                break;
            case "pairing":
                info.pairingCode = msg.code;
                workerEvents.emit(`pairing:${sessionId}`, msg.code);
                break;
            case "pairing_error":
                workerEvents.emit(`pairing_error:${sessionId}`, msg.error);
                break;
            case "connected":
                info.status = "connected";
                info.phoneNumber = msg.phoneNumber;
                info.qrDataUrl = undefined;
                info.restartCount = 0;
                workerEvents.emit(`connected:${sessionId}`, msg.phoneNumber);
                break;
            case "disconnected": info.status = "disconnected"; break;
            case "logged_out":
                info.status = "disconnected";
                info.qrDataUrl = undefined;
                info.pairingCode = undefined;
                break;
            case "error":
                workerEvents.emit(`error:${sessionId}`, msg.error);
                break;
        }
    });

    child.on("exit", (code) => {
        if (workers.get(sessionId) !== info) return;
        if (info.killedByUser) { workers.delete(sessionId); return; }

        // 🔑 If it crashed before generating a code, tell Telegram
        if (info.pairingCode === undefined && info.phone) {
            workerEvents.emit(`error:${sessionId}`, `Worker crashed (code ${code}). Check Render logs.`);
        }

        info.restartCount++;
        if (info.restartCount > 5) { workers.delete(sessionId); return; }

        const delay = Math.min(3000 * info.restartCount, 30000);
        setTimeout(() => {
            if (workers.get(sessionId) !== info) return;
            spawnWorker(sessionId, info.phone);
        }, delay);
    });

    return info;
}

export function killWorker(sessionId: string): void {
    const w = workers.get(sessionId);
    if (!w) return;
    w.killedByUser = true;
    try { if (w.process.connected && w.process.send) w.process.send({ type: "kill" }); } catch { }
    setTimeout(() => { try { w.process.kill("SIGKILL"); } catch { } }, 2000);
    workers.delete(sessionId);
}

export function getWorker(sessionId: string): WorkerInfo | undefined {
    return workers.get(sessionId);
}