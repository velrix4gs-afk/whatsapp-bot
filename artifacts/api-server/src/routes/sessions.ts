import { Router, type IRouter, type Request, type Response } from "express";
import { spawnWorker, killWorker, getWorker, getAllWorkers } from "../lib/manager";

const router: IRouter = Router();

function getParam(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

router.get("/sessions", (_req: Request, res: Response) => {
  try {
    const sessions = getAllWorkers().map(w => ({
      id: w.sessionId,
      label: w.phone || w.sessionId,
      status: w.status,
      qrDataUrl: w.qrDataUrl,
      pairingCode: w.pairingCode,
      phoneNumber: w.phoneNumber,
    }));
    res.json({ ok: true, sessions });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

router.get("/sessions/:id", (req: Request, res: Response) => {
  try {
    const id = getParam(req, "id");
    const w = getWorker(id);
    if (!w) {
      res.status(404).json({ ok: false, error: "Session not found" });
      return;
    }
    res.json({ ok: true, session: w });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

router.post("/sessions", async (req: Request, res: Response) => {
  try {
    const { id, label } = req.body || {};
    const sessionId = id || `user_${Date.now()}`;

    // spawnWorker takes sessionId and phone. We extract phone from ID if not provided.
    const phone = sessionId.replace(/^user_/, "");
    spawnWorker(sessionId, phone);

    await new Promise(r => setTimeout(r, 2000));
    const w = getWorker(sessionId);
    res.json({ ok: true, session: w });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

router.post("/sessions/:id/pairing", async (req: Request, res: Response) => {
  try {
    const id = getParam(req, "id");
    const w = getWorker(id);
    if (!w || !w.pairingCode) {
      res.status(400).json({ ok: false, error: "Pairing code not ready yet. Try again." });
      return;
    }
    res.json({ ok: true, code: w.pairingCode });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

router.delete("/sessions/:id", (req: Request, res: Response) => {
  try {
    const id = getParam(req, "id");
    killWorker(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

export default router;