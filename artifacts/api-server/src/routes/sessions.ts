import { Router, type Request, type Response } from "express";
import {
  getAllSessions,
  getSessionState,
  startSession,
  stopSession,
  deleteSession,
  requestPairingCode,
} from "../lib/whatsapp-bot";
import { getSession as getAuthSession } from "../lib/settings";

const router = Router();

function requireSession(req: Request, res: Response, next: () => void): void {
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !getAuthSession(token)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function serializeSession(s: ReturnType<typeof getSessionState>) {
  if (!s) return null;
  return {
    id: s.id,
    label: s.label,
    status: s.status,
    hasQr: !!s.qrDataUrl,
    pairingCode: s.pairingCode,
    phoneNumber: s.phoneNumber,
    savedFiles: s.savedFiles.slice(0, 10),
    log: s.log.slice(0, 20),
  };
}

// GET /api/sessions — list all sessions
router.get("/sessions", requireSession, (_req, res) => {
  res.json(getAllSessions().map(serializeSession));
});

// POST /api/sessions — create + start a new session
router.post("/sessions", requireSession, async (req: Request, res: Response) => {
  const id    = String(req.body?.id ?? "").trim().replace(/[^a-z0-9_-]/gi, "").slice(0, 32);
  const label = String(req.body?.label ?? id).slice(0, 64);
  if (!id) { res.status(400).json({ error: "id is required (alphanumeric)" }); return; }
  if (getSessionState(id)) { res.status(409).json({ error: "Session already exists" }); return; }
  startSession(id, label).catch(console.error);
  res.status(202).json({ ok: true, id, label, message: "Session starting — poll /api/sessions for status" });
});

// GET /api/sessions/:id — get single session state + QR PNG URL
router.get("/sessions/:id", requireSession, (req, res) => {
  const s = getSessionState(req.params["id"]!);
  if (!s) { res.status(404).json({ error: "Session not found" }); return; }
  res.json(serializeSession(s));
});

// GET /api/sessions/:id/qr.png
router.get("/sessions/:id/qr.png", (req, res) => {
  const s = getSessionState(req.params["id"]!);
  if (!s?.qrDataUrl) { res.status(404).json({ error: "No QR code" }); return; }
  const base64 = s.qrDataUrl.replace(/^data:image\/png;base64,/, "");
  res.setHeader("Content-Type", "image/png").setHeader("Cache-Control", "no-store");
  res.send(Buffer.from(base64, "base64"));
});

// POST /api/sessions/:id/pairing-code — request number-based login
router.post("/sessions/:id/pairing-code", requireSession, async (req: Request, res: Response) => {
  const phone = String(req.body?.phone ?? "").replace(/\D/g, "");
  if (!phone) { res.status(400).json({ error: "phone required" }); return; }
  try {
    const code = await requestPairingCode(req.params["id"]!, phone);
    res.json({ ok: true, code });
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

// DELETE /api/sessions/:id — stop & remove session
router.delete("/sessions/:id", requireSession, (req, res) => {
  const id = req.params["id"]!;
  if (id === "default") { res.status(400).json({ error: "Cannot delete default session" }); return; }
  if (!getSessionState(id)) { res.status(404).json({ error: "Session not found" }); return; }
  deleteSession(id);
  res.json({ ok: true });
});

// POST /api/sessions/:id/restart
router.post("/sessions/:id/restart", requireSession, async (req: Request, res: Response) => {
  const id = req.params["id"]!;
  stopSession(id);
  setTimeout(() => startSession(id).catch(console.error), 500);
  res.json({ ok: true, message: "Session restarting" });
});

export default router;
