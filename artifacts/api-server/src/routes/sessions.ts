import { Router, type IRouter, type Request, type Response } from "express";
import { spawnWorker, killWorker, getWorker, getAllWorkers, toPublicWorker } from "../lib/manager";

const router: IRouter = Router();

function getParam(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

function phoneFromId(sessionId: string): string {
  const fromId = sessionId.replace(/^user_/, "");
  return /^\d+$/.test(fromId) ? fromId : "";
}

router.get("/sessions", (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, sessions: getAllWorkers().map(toPublicWorker) });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

router.get("/sessions/:id", (req: Request, res: Response) => {
  try {
    const w = getWorker(getParam(req, "id"));
    if (!w) {
      res.status(404).json({ ok: false, error: "Session not found" });
      return;
    }
    res.json({ ok: true, session: toPublicWorker(w) });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// Create / ensure a session. Reuses a live worker instead of spawning a new one.
router.post("/sessions", (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const rawId: string = body.id || `user_${String(body.phone ?? "").replace(/\D/g, "")}`;
    const phone: string = String(body.phone ?? phoneFromId(rawId)).replace(/\D/g, "");

    if (!rawId || rawId === "user_") {
      res.status(400).json({ ok: false, error: "A phone number is required" });
      return;
    }

    const w = spawnWorker(rawId, phone);
    res.json({ ok: true, session: toPublicWorker(w) });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// Read the current pairing code (does not spawn). Returns pending:true while waiting.
router.post("/sessions/:id/pairing", (req: Request, res: Response) => {
  try {
    const w = getWorker(getParam(req, "id"));
    if (!w) {
      res.status(404).json({ ok: false, error: "Session not found" });
      return;
    }
    if (w.pairingCode) {
      res.json({ ok: true, code: w.pairingCode });
      return;
    }
    res.status(202).json({ ok: false, pending: true, status: w.status, error: "Preparing pairing code…" });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// Force a fresh worker (used by the Restart button).
router.post("/sessions/:id/restart", (req: Request, res: Response) => {
  try {
    const id = getParam(req, "id");
    const w = spawnWorker(id, phoneFromId(id), { force: true });
    res.json({ ok: true, session: toPublicWorker(w) });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

router.delete("/sessions/:id", (req: Request, res: Response) => {
  try {
    killWorker(getParam(req, "id"));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

export default router;
