import { useEffect, useState, useCallback } from "react";
import Settings from "./pages/Settings";
import Sessions from "./pages/Sessions";

type Status = "disconnected" | "qr" | "connecting" | "connected";
type Tab = "dashboard" | "sessions" | "settings";

interface BotStatus {
  status: Status;
  phoneNumber: string | null;
  savedFiles: string[];
  log: string[];
  hasQr: boolean;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API  = `${BASE}/api`;

const STATUS_CFG: Record<Status, { label: string; color: string; bg: string }> = {
  connected:    { label: "Connected",    color: "#22c55e", bg: "rgba(34,197,94,.12)"   },
  qr:           { label: "Link Device",  color: "#f59e0b", bg: "rgba(245,158,11,.12)"  },
  connecting:   { label: "Connecting…",  color: "#60a5fa", bg: "rgba(96,165,250,.12)"  },
  disconnected: { label: "Disconnected", color: "#f87171", bg: "rgba(248,113,113,.12)" },
};

function useBotStatus() {
  const [data, setData] = useState<BotStatus | null>(null);
  const [qrTs, setQrTs] = useState(Date.now());
  const poll = useCallback(async () => {
    try {
      const res = await fetch(`${API}/bot/status`);
      if (!res.ok) return;
      const json: BotStatus = await res.json();
      setData((prev) => { if (prev?.hasQr !== json.hasQr) setQrTs(Date.now()); return json; });
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { poll(); const id = setInterval(poll, 3000); return () => clearInterval(id); }, [poll]);
  return { data, qrTs };
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: "hsl(222 47% 11%)", border: "1px solid hsl(218 35% 17%)", borderRadius: 14, padding: 22, ...style }}>{children}</div>;
}
function STitle({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: "hsl(215 20% 42%)", marginBottom: 14 }}>{children}</p>;
}

// ── Phone/QR link card (shown when bot is waiting to be linked) ──────────────

function LinkCard({ qrTs, hasQr }: { qrTs: number; hasQr: boolean }) {
  const [method, setMethod]   = useState<"phone" | "qr">("phone");
  const [phone, setPhone]     = useState("");
  const [code, setCode]       = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState("");
  const [copied, setCopied]   = useState(false);

  async function getCode() {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 7) { setErr("Enter your full number with country code — e.g. 14155551234"); return; }
    setLoading(true); setErr(""); setCode("");
    try {
      const res = await fetch(`${API}/bot/pairing-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: digits }),
      });
      const d = await res.json();
      if (!res.ok) { setErr(d.error ?? "Failed to get code"); }
      else         { setCode(d.code); }
    } catch { setErr("Network error — is the server running?"); }
    setLoading(false);
  }

  async function copyCode() {
    await navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const tabBtn = (id: "phone" | "qr", label: string) => (
    <button
      onClick={() => { setMethod(id); setErr(""); }}
      style={{
        flex: 1, padding: "9px 0", border: "none", borderRadius: 8, cursor: "pointer",
        fontSize: 13, fontWeight: 600, fontFamily: "inherit",
        background: method === id ? "hsl(218 35% 22%)" : "transparent",
        color: method === id ? "hsl(213 31% 88%)" : "hsl(215 20% 42%)",
      }}
    >{label}</button>
  );

  return (
    <Card>
      <STitle>Link WhatsApp to this Bot</STitle>

      {/* Tab switcher */}
      <div style={{ display: "flex", gap: 4, background: "hsl(222 47% 8%)", borderRadius: 10, padding: 3, marginBottom: 20 }}>
        {tabBtn("phone", "📱 Phone Number")}
        {tabBtn("qr",    "📷 Scan QR Code")}
      </div>

      {/* ── Phone Number Tab ── */}
      {method === "phone" && (
        <div>
          <p style={{ fontSize: 13, color: "hsl(215 20% 52%)", marginBottom: 16, lineHeight: 1.6 }}>
            Enter your WhatsApp number with country code. You'll get an 8-character code to enter in WhatsApp.
          </p>

          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              type="tel"
              placeholder="e.g. 14155551234"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              onKeyDown={e => e.key === "Enter" && getCode()}
              style={{
                flex: 1, padding: "12px 14px", background: "hsl(222 47% 8%)",
                border: "1px solid hsl(218 35% 22%)", borderRadius: 10,
                color: "hsl(213 31% 88%)", fontSize: 16, outline: "none", fontFamily: "inherit",
              }}
              autoFocus
            />
            <button
              onClick={getCode}
              disabled={loading}
              style={{
                padding: "12px 18px", borderRadius: 10, border: "none", cursor: "pointer",
                background: "hsl(142 72% 50%)", color: "hsl(144 80% 10%)",
                fontSize: 13, fontWeight: 700, fontFamily: "inherit",
                opacity: loading ? 0.6 : 1, flexShrink: 0,
              }}
            >{loading ? "…" : "Get Code"}</button>
          </div>

          {err && (
            <p style={{ fontSize: 12, color: "#f87171", marginBottom: 12, padding: "8px 12px", background: "rgba(248,113,113,.08)", borderRadius: 8 }}>{err}</p>
          )}

          {code ? (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 11, color: "hsl(215 20% 42%)", marginBottom: 8, textTransform: "uppercase", letterSpacing: ".07em", fontWeight: 700 }}>Your Pairing Code</p>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{
                  flex: 1, background: "hsl(222 47% 7%)", border: "2px solid hsl(142 72% 40%)",
                  borderRadius: 12, padding: "14px 18px", textAlign: "center",
                  fontFamily: "monospace", fontSize: 32, fontWeight: 800,
                  letterSpacing: "0.18em", color: "#f59e0b",
                }}>
                  {code}
                </div>
                <button
                  onClick={copyCode}
                  style={{
                    padding: "14px 16px", borderRadius: 10, border: "none", cursor: "pointer",
                    background: copied ? "hsl(142 72% 50%)" : "hsl(218 35% 18%)",
                    color: copied ? "hsl(144 80% 10%)" : "hsl(213 31% 72%)",
                    fontSize: 13, fontWeight: 600, fontFamily: "inherit", flexShrink: 0,
                  }}
                >{copied ? "✓" : "Copy"}</button>
              </div>

              <div style={{ marginTop: 16, background: "hsl(222 47% 8%)", borderRadius: 10, padding: 14 }}>
                <p style={{ fontSize: 12, fontWeight: 700, color: "hsl(213 31% 78%)", marginBottom: 10 }}>How to link on WhatsApp:</p>
                {[
                  "Open WhatsApp on your phone",
                  "Tap ⋮ (Android) or Settings (iPhone)",
                  'Go to Linked Devices → Link a Device',
                  'Tap "Link with phone number instead"',
                  "Enter the code above when prompted",
                ].map((step, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                    <span style={{ width: 20, height: 20, borderRadius: "50%", background: "hsl(218 35% 22%)", color: "hsl(142 72% 60%)", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</span>
                    <span style={{ fontSize: 12, color: "hsl(215 20% 55%)", lineHeight: 1.5 }}>{step}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            !loading && (
              <div style={{ marginTop: 4, background: "hsl(222 47% 8%)", borderRadius: 10, padding: 14 }}>
                <p style={{ fontSize: 12, fontWeight: 700, color: "hsl(213 31% 78%)", marginBottom: 8 }}>How it works:</p>
                <p style={{ fontSize: 12, color: "hsl(215 20% 48%)", lineHeight: 1.6 }}>
                  1. Enter your number above and tap <strong style={{ color: "hsl(213 31% 70%)" }}>Get Code</strong><br/>
                  2. Open WhatsApp → ⋮ → Linked Devices → Link a Device<br/>
                  3. Tap <strong style={{ color: "hsl(213 31% 70%)" }}>"Link with phone number instead"</strong><br/>
                  4. Enter the 8-character code shown here
                </p>
              </div>
            )
          )}
        </div>
      )}

      {/* ── QR Code Tab ── */}
      {method === "qr" && (
        <div style={{ textAlign: "center" }}>
          {hasQr ? (
            <>
              <img
                key={qrTs}
                src={`${API}/bot/qr.png?t=${qrTs}`}
                alt="WhatsApp QR Code"
                style={{ width: 220, height: 220, borderRadius: 12, border: "1px solid hsl(218 35% 20%)" }}
              />
              <p style={{ marginTop: 12, fontSize: 13, color: "#f59e0b", lineHeight: 1.7 }}>
                Open WhatsApp → tap ⋮ → <strong>Linked Devices</strong> → <strong>Link a Device</strong>
              </p>
              <p style={{ marginTop: 8, fontSize: 11, color: "hsl(215 20% 38%)" }}>Tap the QR to refresh it if it expires</p>
            </>
          ) : (
            <p style={{ fontSize: 13, color: "hsl(215 20% 42%)", padding: "20px 0" }}>QR not ready yet — wait a moment and try again.</p>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Dashboard ────────────────────────────────────────────────────────────────

function Dashboard() {
  const { data, qrTs } = useBotStatus();

  if (!data) return (
    <div style={{ minHeight: "50vh", display: "flex", alignItems: "center", justifyContent: "center", color: "hsl(215 20% 42%)", fontSize: 14 }}>
      Connecting to bot…
    </div>
  );

  const cfg = STATUS_CFG[data.status];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 24 }}>📱</span>
            <span style={{ fontSize: 19, fontWeight: 700, color: "hsl(213 31% 91%)" }}>WhatsApp Bot</span>
          </div>
          {data.status === "connected"   && data.phoneNumber && <p style={{ fontSize: 13, color: "hsl(215 20% 48%)", marginTop: 4 }}>Logged in as <strong style={{ color: "hsl(213 31% 78%)" }}>+{data.phoneNumber}</strong></p>}
          {data.status === "qr"          && <p style={{ fontSize: 13, color: "hsl(215 20% 48%)", marginTop: 4 }}>Waiting to be linked…</p>}
          {data.status === "connecting"  && <p style={{ fontSize: 13, color: "hsl(215 20% 48%)", marginTop: 4 }}>Starting up…</p>}
          {data.status === "disconnected"&& <p style={{ fontSize: 13, color: "hsl(215 20% 48%)", marginTop: 4 }}>Reconnecting automatically…</p>}
        </div>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "6px 14px", borderRadius: 999, background: cfg.bg, color: cfg.color, fontSize: 13, fontWeight: 600 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: cfg.color, boxShadow: `0 0 6px ${cfg.color}` }} />
          {cfg.label}
        </span>
      </Card>

      {data.status === "qr" && <LinkCard qrTs={qrTs} hasQr={data.hasQr} />}

      {data.status === "connected" && (
        <Card>
          <STitle>Active Features</STitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[
              { icon: "🎲", name: "Auto-react Statuses",     desc: "Random emoji reaction to every contact status" },
              { icon: "💾", name: "Auto-download Statuses",  desc: "Saves all status photos/videos to disk automatically" },
              { icon: "📥", name: ".save command",             desc: 'Reply to any status with ".save" → bot DMs you the media' },
              { icon: "🖼️", name: ".savepp command",         desc: 'Send ".savepp" in any DM to save a profile picture' },
              { icon: "🔓", name: "View-Once Capture + .vv", desc: 'Auto-saves view-once media · Reply with ".vv" to save manually' },
              { icon: "🚫", name: "Anti-Delete",             desc: "Reposts deleted messages to the same chat" },
              { icon: "🤖", name: "AI Chat (Gemini)",        desc: 'Send ".ai on" in any chat to enable AI replies' },
              { icon: "🎭", name: ".sticker Command",        desc: 'Send an image/video with ".sticker" → receive it as a sticker' },
              { icon: "👋", name: "Welcome / Goodbye",       desc: "Auto-message when members join or leave groups" },
              { icon: "⌨️",  name: "Custom Commands",         desc: 'Custom dot-prefix commands (e.g. .ping, .about)' },
            ].map((f) => (
              <div key={f.name} style={{ display: "flex", gap: 14, background: "hsl(222 47% 8%)", borderRadius: 10, padding: 12 }}>
                <span style={{ fontSize: 20, lineHeight: 1.2, flexShrink: 0 }}>{f.icon}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "hsl(213 31% 88%)", marginBottom: 2 }}>{f.name}</div>
                  <div style={{ fontSize: 11, color: "hsl(215 20% 43%)", lineHeight: 1.5 }}>{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <STitle>Saved Files ({data.savedFiles.length})</STitle>
        {data.savedFiles.length === 0
          ? <p style={{ fontSize: 13, color: "hsl(215 20% 38%)" }}>No files saved yet.</p>
          : data.savedFiles.map((f, i) => (
              <div key={f} style={{ fontSize: 11, color: "hsl(215 20% 54%)", padding: "7px 0", borderBottom: i < data.savedFiles.length - 1 ? "1px solid hsl(218 35% 14%)" : "none", fontFamily: "monospace" }}>{f}</div>
            ))
        }
      </Card>

      <Card>
        <STitle>Activity Log</STitle>
        {data.log.length === 0
          ? <p style={{ fontSize: 13, color: "hsl(215 20% 38%)" }}>No activity yet.</p>
          : <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {data.log.map((line, i) => (
                <div key={i} style={{ fontSize: 11, color: "hsl(215 20% 50%)", padding: "5px 0", borderBottom: "1px solid hsl(222 47% 9%)", lineHeight: 1.5 }}>{line}</div>
              ))}
            </div>
        }
      </Card>

      <p style={{ textAlign: "center", fontSize: 11, color: "hsl(215 20% 26%)", paddingBottom: 8 }}>Polling every 3 seconds · Auto-reconnects on disconnect</p>
    </div>
  );
}

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "dashboard", label: "📊 Dashboard" },
    { id: "sessions",  label: "📱 Sessions"  },
    { id: "settings",  label: "⚙️ Settings"  },
  ];
  return (
    <div style={{ display: "flex", gap: 4, background: "hsl(222 47% 11%)", border: "1px solid hsl(218 35% 17%)", borderRadius: 12, padding: 4 }}>
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)} style={{ flex: 1, padding: "8px 0", border: "none", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: active === t.id ? "hsl(218 35% 20%)" : "transparent", color: active === t.id ? "hsl(213 31% 88%)" : "hsl(215 20% 42%)", transition: "all .15s" }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [tab, setTab]     = useState<Tab>("dashboard");
  const [token, setToken] = useState(() => localStorage.getItem("bot_token") ?? "");

  return (
    <>
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: hsl(222 47% 8%); }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: hsl(218 35% 20%); border-radius: 2px; }
      `}</style>
      <div style={{ minHeight: "100vh", padding: "20px 16px", fontFamily: "system-ui, -apple-system, sans-serif" }}>
        <div style={{ maxWidth: 600, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
          <TabBar active={tab} onChange={setTab} />
          {tab === "dashboard" && <Dashboard />}
          {tab === "sessions"  && (
            token
              ? <Sessions token={token} />
              : <div style={{ background: "hsl(222 47% 11%)", border: "1px solid hsl(218 35% 17%)", borderRadius: 14, padding: 22, textAlign: "center" }}>
                  <p style={{ fontSize: 13, color: "hsl(215 20% 48%)" }}>Log in via Settings to manage sessions.</p>
                  <button onClick={() => setTab("settings")} style={{ marginTop: 12, padding: "8px 16px", background: "hsl(218 35% 20%)", border: "none", borderRadius: 9, color: "hsl(213 31% 75%)", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Go to Settings →</button>
                </div>
          )}
          {tab === "settings" && (
            <Settings onBack={() => setTab("dashboard")} onLoggedIn={(tok) => setToken(tok)} />
          )}
        </div>
      </div>
    </>
  );
}
