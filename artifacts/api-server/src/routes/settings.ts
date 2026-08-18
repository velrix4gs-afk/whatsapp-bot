import { Router, type Request, type Response, type NextFunction } from "express";
import {
  loadSettings,
  applySettings,
  createOtp,
  verifyOtpAndCreateSession,
  getSession,
  hasDashboardPin,
  hasDashboardPinAsync,
  verifyPinAndCreateSession,
  registerUser,
  changeUserPin,
  listUsers,
  deleteUser,
  type BotSettings,
} from "../lib/settings";
import { getSock } from "../lib/whatsapp-bot";
import { loadCustomCommands, getCommandsFile } from "../lib/features/custom-commands";
import fs from "fs";

const router = Router();

function requireSession(req: Request, res: Response, next: NextFunction): void {
  const auth  = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const session = token ? getSession(token) : null;
  if (!session) { res.status(401).json({ error: "Unauthorized" }); return; }
  (req as Request & { user?: { phone: string } }).user = { phone: session.phone };
  next();
}

// GET /api/settings/auth-status
router.get("/settings/auth-status", async (_req, res) => {
  const anyUser = await hasDashboardPinAsync().catch(() => hasDashboardPin());
  res.json({ anyUser, botConnected: !!getSock() });
});

// POST /api/settings/register
router.post("/settings/register", async (req: Request, res: Response) => {
  const phone = String(req.body?.phone ?? "");
  const pin   = String(req.body?.pin ?? "").trim();
  const label = req.body?.label ? String(req.body.label) : undefined;
  const result = await registerUser(phone, pin, label);
  if (!result.ok) { res.status(400).json({ error: result.error }); return; }
  const session = await verifyPinAndCreateSession(phone, pin);
  if (!session) { res.status(500).json({ error: "Account created but session failed — try logging in" }); return; }
  res.json({ ok: true, token: session.token, phone: session.phone, isOwner: session.isOwner,
    message: result.isOwner ? "Account created — you are the owner!" : "Account created — logged in." });
});

// POST /api/settings/pin-login
router.post("/settings/pin-login", async (req: Request, res: Response) => {
  const phone = String(req.body?.phone ?? "");
  const pin   = String(req.body?.pin ?? "").trim();
  if (!phone || !pin) { res.status(400).json({ error: "Phone number and PIN required" }); return; }
  const session = await verifyPinAndCreateSession(phone, pin);
  if (!session) { res.status(401).json({ error: "Wrong phone number or PIN" }); return; }
  res.json({ ok: true, token: session.token, phone: session.phone, isOwner: session.isOwner });
});

// POST /api/settings/set-pin
router.post("/settings/set-pin", requireSession, async (req: Request, res: Response) => {
  const sess = (req as Request & { user?: { phone: string } }).user!;
  const pin  = String(req.body?.pin ?? "").trim();
  if (!pin || pin.length < 4) { res.status(400).json({ error: "PIN must be at least 4 characters" }); return; }
  const ok = await changeUserPin(sess.phone, pin);
  if (!ok) { res.status(404).json({ error: "User not found" }); return; }
  res.json({ ok: true, message: "PIN updated" });
});

// GET /api/settings/users
router.get("/settings/users", requireSession, async (_req, res) => {
  const users = await listUsers();
  res.json({ users });
});

// DELETE /api/settings/users/:phone
router.delete("/settings/users/:phone", requireSession, async (req: Request, res: Response) => {
  const sess = (req as Request & { user?: { phone: string } }).user!;
  const all  = await listUsers();
  const me   = all.find(u => u.phone === sess.phone);
  if (!me?.isOwner) { res.status(403).json({ error: "Only the owner can remove users" }); return; }
  if (req.params["phone"] === sess.phone) { res.status(400).json({ error: "Cannot remove your own account" }); return; }
  const ok = await deleteUser(req.params["phone"] ?? "");
  if (!ok) { res.status(404).json({ error: "User not found" }); return; }
  res.json({ ok: true });
});

// POST /api/settings/otp
router.post("/settings/otp", async (req: Request, res: Response) => {
  const phone = String(req.body?.phone ?? "").replace(/\D/g, "");
  if (!phone || phone.length < 7) { res.status(400).json({ error: "Invalid phone number" }); return; }
  const sock = getSock();
  if (!sock) { res.status(503).json({ error: "Bot not connected — use your PIN instead" }); return; }
  const code = createOtp(phone);
  try {
    await sock.sendMessage(`${phone}@s.whatsapp.net`, {
      text: `🔐 Your dashboard code: *${code}*\n\nExpires in 5 minutes.`,
    });
    res.json({ ok: true, message: "Code sent via WhatsApp" });
  } catch (err) {
    res.status(500).json({ error: `Could not send code: ${(err as Error).message}` });
  }
});

// POST /api/settings/verify
router.post("/settings/verify", (req: Request, res: Response) => {
  const phone = String(req.body?.phone ?? "").replace(/\D/g, "");
  const code  = String(req.body?.code  ?? "").trim();
  const token = verifyOtpAndCreateSession(phone, code);
  if (!token) { res.status(401).json({ error: "Invalid or expired code" }); return; }
  res.json({ ok: true, token });
});

// GET /api/settings
router.get("/settings", requireSession, (_req, res) => {
  res.json(loadSettings());
});

// POST /api/settings
router.post("/settings", requireSession, (req: Request, res: Response) => {
  const body    = req.body as Partial<BotSettings>;
  const current = loadSettings();
  const updated: BotSettings = {
    features:          { ...current.features,          ...body.features },
    reactionEmojis:    Array.isArray(body.reactionEmojis) && body.reactionEmojis.length > 0 ? body.reactionEmojis : current.reactionEmojis,
    keywordReplies:    Array.isArray(body.keywordReplies)    ? body.keywordReplies    : current.keywordReplies,
    welcomeMessage:    body.welcomeMessage    ?? current.welcomeMessage,
    goodbyeMessage:    body.goodbyeMessage    ?? current.goodbyeMessage,
    antiLinkWhitelist: Array.isArray(body.antiLinkWhitelist) ? body.antiLinkWhitelist : current.antiLinkWhitelist,
    aiSystemPrompt:    body.aiSystemPrompt    ?? current.aiSystemPrompt,
  };
  applySettings(updated);
  res.json({ ok: true, settings: updated });
});

// GET /api/settings/custom-commands
router.get("/settings/custom-commands", requireSession, (_req, res) => {
  res.json({ commands: loadCustomCommands(), file: getCommandsFile() });
});

// POST /api/settings/custom-commands
router.post("/settings/custom-commands", requireSession, (req: Request, res: Response) => {
  const commands = req.body?.commands;
  if (!Array.isArray(commands)) { res.status(400).json({ error: "commands must be an array" }); return; }
  try {
    fs.writeFileSync(getCommandsFile(), JSON.stringify(commands, null, 2));
    res.json({ ok: true, count: commands.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
