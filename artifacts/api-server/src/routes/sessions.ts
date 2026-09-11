import { Router, type IRouter, type Request, type Response } from "express";
import {
  startSession,
  getAllSessions,
  getSessionState,
  deleteSession,
  stopSession,
  requestPairingCode,
} from "../lib/whatsapp-bot";

const router: IRouter = Router();

// Helper to safely get a route param as string
function getParam(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

// List all sessions
router.get("/sessions", (_req: Request, res: Response) => {
  try {
    const sessions = getAllSessions();
    res.json({ ok: true, sessions });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// Get one session
router.get("/sessions/:id", (req: Request, res: Response) => {
  try {
    const id = getParam(req, "id");
    const session = getSessionState(id);
    if (!session) {
      res.status(404).json({ ok: false, error: "Session not found" });
      return;
    }
    res.json({ ok: true, session });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// Create new session
router.post("/sessions", async (req: Request, res: Response) => {
  try {
    const { id, label } = req.body || {};
    const sessionId = id || `user_${Date.now()}`;
    const sessionLabel = label || sessionId;

    startSession(sessionId, sessionLabel).catch(err => {
      console.error(`Session ${sessionId} start error:`, err);
    });

    await new Promise(r => setTimeout(r, 2000));

    const session = getSessionState(sessionId);
    res.json({ ok: true, session });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// Request pairing code
router.post("/sessions/:id/pairing", async (req: Request, res: Response) => {
  try {
    const id = getParam(req, "id");
    const { phone } = req.body || {};
    if (!phone) {
      res.status(400).json({ ok: false, error: "Phone number required" });
      return;
    }

    const code = await requestPairingCode(id, phone);
    res.json({ ok: true, code });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// Stop session
router.post("/sessions/:id/stop", (req: Request, res: Response) => {
  try {
    const id = getParam(req, "id");
    stopSession(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// Delete session 
router.delete("/sessions/:id", (req: Request, res: Response) => {
  try {
    const id = getParam(req, "id");
    deleteSession(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

export default router;  