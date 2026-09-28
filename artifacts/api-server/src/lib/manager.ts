import { spawn, type ChildProcess } from "child_process";
import path from "path";

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

const workers = new Map<string, WorkerInfo>();

// Worker path is relative to current working directory
// (the bot runs from artifacts/api-server, so worker.ts is in src/)
const WORKER_PATH = path.join(process.cwd(), "src", "worker.ts");

export function spawnWorker(sessionId: string, phone?: string): WorkerInfo {
    // Kill existing worker if any
    if (workers.has(sessionId)) {
        killWorker(sessionId);
    }

    // Spawn node directly with tsx as ESM loader — no shell, no orphaned processes
    const child = spawn(
        process.execPath,
        ["--import", "tsx", WORKER_PATH],
        {
            cwd: process.cwd(),
            stdio: ["ignore", "inherit", "inherit", "ipc"],
            env: {
                ...process.env,
                WORKER_SESSION_ID: sessionId,
                WORKER_PHONE: phone || "",
            },
        }
    );

    const info: WorkerInfo = {
        sessionId,
        phone,
        status: "starting",
        process: child,
        restartCount: 0,
    };

    workers.set(sessionId, info);
    console.log(`🟢 Worker spawned: ${sessionId} (pid ${child.pid})`);

    // ── Message handler ────────────────────────────────────────────────
    child.on("message", (msg: any) => {
        if (!msg || typeof msg !== "object") return;

        // Ignore messages from stale workers
        if (workers.get(sessionId) !== info) return;

        switch (msg.type) {
            case "started":
                info.status = "connecting";
                break;

            case "qr":
                info.status = "qr";
                import("qrcode")
                    .then(({ default: QRCode }) =>
                        QRCode.toDataURL(msg.qr, { width: 300 }).then((url) => {
                            info.qrDataUrl = url;
                        })
                    )
                    .catch(() => { });
                break;

            case "pairing":
                info.pairingCode = msg.code;
                break;

            case "connected":
                info.status = "connected";
                info.phoneNumber = msg.phoneNumber;
                info.qrDataUrl = undefined;
                info.restartCount = 0;
                break;

            case "disconnected":
                info.status = "disconnected";
                break;

            case "logged_out":
                info.status = "disconnected";
                info.qrDataUrl = undefined;
                info.pairingCode = undefined;
                break;

            case "error":
                info.status = "disconnected";
                break;
        }
    });

    // ── Exit handler ───────────────────────────────────────────────────
    child.on("exit", (code, signal) => {
        // 🔑 Ignore exits from stale workers (already replaced)
        const current = workers.get(sessionId);
        if (current !== info) {
            console.log(`🔴 Stale worker exit ignored: ${sessionId}`);
            return;
        }

        if (info.killedByUser) {
            console.log(`🔴 Worker killed by user: ${sessionId}`);
            workers.delete(sessionId);
            return;
        }

        info.restartCount++;
        if (info.restartCount > 5) {
            console.log(`🚫 Worker ${sessionId} crashed 5 times — giving up`);
            workers.delete(sessionId);
            return;
        }

        const delay = Math.min(3000 * info.restartCount, 30000);
        console.log(
            `⚠️ Worker ${sessionId} exited (code=${code}) — restart #${info.restartCount} in ${delay}ms`
        );

        setTimeout(() => {
            // Only restart if this worker is still the current one
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

    // Tell worker to shut down gracefully
    try {
        if (w.process.connected && w.process.send) {
            w.process.send({ type: "kill" });
        }
    } catch { }

    // Force kill after 2 seconds
    setTimeout(() => {
        try {
            w.process.kill("SIGKILL");
        } catch { }
    }, 2000);

    workers.delete(sessionId);
}

export function getWorker(sessionId: string): WorkerInfo | undefined {
    return workers.get(sessionId);
}

export function getAllWorkers(): WorkerInfo[] {
    return Array.from(workers.values());
}