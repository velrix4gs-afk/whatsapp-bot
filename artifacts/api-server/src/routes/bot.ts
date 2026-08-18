import { Router, type Request, type Response } from "express";
import { botState, requestPairingCode } from "../lib/whatsapp-bot";
import { getHeartbeatInfo, formatUptime } from "../lib/heartbeat";

const router = Router();

/* ── dashboard ──────────────────────────────────────────────── */
router.get("/bot", (_req, res) => {
  const COLORS: Record<string, string> = {
    connected: "#22c55e",
    qr: "#f59e0b",
    connecting: "#60a5fa",
    disconnected: "#ef4444",
  };
  const LABELS: Record<string, string> = {
    connected: "● Connected",
    qr: "● Scan QR Code",
    connecting: "◌ Connecting…",
    disconnected: "○ Disconnected",
  };

  const color = COLORS[botState.status] ?? "#6b7280";
  const label = LABELS[botState.status] ?? botState.status;

  const qrSection =
    botState.status === "qr" && botState.qrDataUrl
      ? `<div class="card center">
          <p class="section-title">Scan to Login</p>
          <img src="${botState.qrDataUrl}" class="qr-img" alt="WhatsApp QR Code"/>
          <p class="hint">Open WhatsApp → ⋮ → <strong>Linked Devices</strong> → <strong>Link a Device</strong></p>
         </div>`
      : "";

  const features =
    botState.status === "connected"
      ? `<div class="card">
          <p class="section-title">Active Features</p>
          <div class="feature-list">
            <div class="feature">
              <span class="feat-icon">👍</span>
              <div><div class="feat-name">Auto-like Statuses</div><div class="feat-desc">Reacts to every contact status update automatically</div></div>
            </div>
            <div class="feature">
              <span class="feat-icon">📸</span>
              <div><div class="feat-name">Save Profile Pictures</div><div class="feat-desc">Send <code>#saveprofile 14155551234</code> in any chat</div></div>
            </div>
            <div class="feature">
              <span class="feat-icon">🔓</span>
              <div><div class="feat-name">View-Once Capture</div><div class="feat-desc">Saves &amp; re-sends view-once photos and videos to you</div></div>
            </div>
          </div>
        </div>`
      : "";

  const filesSection = `<div class="card">
    <p class="section-title">Saved Files <span class="badge">${botState.savedFiles.length}</span></p>
    ${
      botState.savedFiles.length
        ? `<ul class="file-list">${botState.savedFiles.map((f) => `<li>${f}</li>`).join("")}</ul>`
        : `<p class="muted">No files saved yet.</p>`
    }
  </div>`;

  const logSection = `<div class="card">
    <p class="section-title">Activity Log</p>
    <div class="log-box">
      ${
        botState.log.length
          ? botState.log.map((l) => `<div class="log-line">${l}</div>`).join("")
          : `<p class="muted">No activity yet.</p>`
      }
    </div>
  </div>`;

  const connectedInfo =
    botState.status === "connected" && botState.phoneNumber
      ? `<p class="sub-label">Logged in as <strong>+${botState.phoneNumber}</strong></p>`
      : botState.status === "qr"
      ? `<p class="sub-label">Waiting for QR scan…</p>`
      : `<p class="sub-label">Bot is starting up…</p>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WhatsApp Bot Dashboard</title>
<meta http-equiv="refresh" content="5"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0b1120;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;padding:28px 16px}
.wrap{max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.card{background:#151f35;border:1px solid #1e3058;border-radius:14px;padding:22px}
.center{text-align:center}
.header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.app-name{font-size:20px;font-weight:700;display:flex;align-items:center;gap:8px}
.status-pill{font-size:12px;font-weight:600;padding:5px 12px;border-radius:999px}
.sub-label{font-size:13px;color:#64748b;margin-top:5px}
.sub-label strong{color:#94a3b8}
.section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#475569;margin-bottom:14px}
.qr-img{width:240px;height:240px;border-radius:10px;margin:8px 0}
.hint{font-size:13px;color:#f59e0b;margin-top:10px;line-height:1.5}
.hint strong{color:#fbbf24}
.feature-list{display:flex;flex-direction:column;gap:12px}
.feature{display:flex;align-items:flex-start;gap:14px;background:#0d1830;border-radius:10px;padding:14px}
.feat-icon{font-size:22px;line-height:1;flex-shrink:0}
.feat-name{font-size:13px;font-weight:600;color:#e2e8f0;margin-bottom:3px}
.feat-desc{font-size:12px;color:#64748b;line-height:1.5}
code{background:#0b1120;color:#7dd3fc;padding:2px 6px;border-radius:4px;font-size:12px;font-family:monospace}
.file-list{list-style:none;display:flex;flex-direction:column;gap:0}
.file-list li{font-size:12px;color:#94a3b8;padding:7px 0;border-bottom:1px solid #1e3058}
.file-list li:last-child{border-bottom:none}
.muted{font-size:13px;color:#334155}
.log-box{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow-y:auto}
.log-line{font-size:12px;color:#94a3b8;padding:5px 0;border-bottom:1px solid #0d1830;line-height:1.4}
.badge{background:#1e3058;color:#7dd3fc;font-size:11px;padding:2px 8px;border-radius:999px;margin-left:6px;font-weight:600}
.footer{text-align:center;font-size:11px;color:#1e3058;padding-bottom:8px}
</style>
</head>
<body>
<div class="wrap">

  <div class="card">
    <div class="header">
      <div>
        <div class="app-name">📱 WhatsApp Bot</div>
        ${connectedInfo}
      </div>
      <div class="status-pill" style="background:${color}22;color:${color}">${label}</div>
    </div>
  </div>

  ${qrSection}
  ${features}
  ${filesSection}
  ${logSection}

  <p class="footer">Auto-refreshes every 5 seconds</p>
</div>
</body>
</html>`);
});

/* ── Pairing code (no auth — accessible from dashboard before login) ── */
router.post("/bot/pairing-code", async (req: Request, res: Response) => {
  const phone = String(req.body?.phone ?? "").replace(/\D/g, "");
  if (!phone || phone.length < 7) { res.status(400).json({ error: "Enter your full number with country code (e.g. 14155551234)" }); return; }
  try {
    const code = await requestPairingCode("default", phone);
    res.json({ ok: true, code });
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

/* ── Health check (used by self-heartbeat) ─────────────────── */
router.get("/bot/health", (_req, res) => {
  const hb = getHeartbeatInfo();
  res.json({
    ok: true,
    botStatus: botState.status,
    uptime: formatUptime(hb.uptimeSec),
    uptimeSec: hb.uptimeSec,
    startedAt: hb.startedAt,
    lastSelfPingAgoSec: hb.lastSelfPingAgoSec,
    lastSelfPingOk: hb.lastSelfPingOk,
  });
});

/* ── JSON status ────────────────────────────────────────────── */
router.get("/bot/status", (_req, res) => {
  res.json({
    status: botState.status,
    phoneNumber: botState.phoneNumber,
    savedFiles: botState.savedFiles,
    log: botState.log,
    hasQr: !!botState.qrDataUrl,
  });
});

/* ── QR as PNG ──────────────────────────────────────────────── */
router.get("/bot/qr.png", (_req, res) => {
  if (!botState.qrDataUrl) {
    res.status(404).json({ error: "No QR code available" });
    return;
  }
  const base64 = botState.qrDataUrl.replace(/^data:image\/png;base64,/, "");
  const buf = Buffer.from(base64, "base64");
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store");
  res.send(buf);
});

export default router;
