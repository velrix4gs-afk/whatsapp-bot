import { useState, useEffect, useCallback } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API = `${BASE}/api`;

type Status = "disconnected" | "qr" | "connecting" | "connected";

interface SessionInfo {
  id: string;
  label: string;
  status: Status;
  hasQr: boolean;
  pairingCode: string | null;
  phoneNumber: string | null;
  log: string[];
}

const STATUS: Record<Status, { color: string; bg: string; label: string }> = {
  connected:    { color: "#22c55e", bg: "rgba(34,197,94,.12)",   label: "Connected"   },
  qr:           { color: "#f59e0b", bg: "rgba(245,158,11,.12)",  label: "Link Device" },
  connecting:   { color: "#60a5fa", bg: "rgba(96,165,250,.12)",  label: "Connecting…" },
  disconnected: { color: "#f87171", bg: "rgba(248,113,113,.12)", label: "Offline"     },
};

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: "hsl(222 47% 11%)", border: "1px solid hsl(218 35% 17%)", borderRadius: 14, padding: 20, ...style }}>
      {children}
    </div>
  );
}
function Btn({ children, variant = "primary", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const bg    = variant === "primary" ? "hsl(142 72% 50%)" : variant === "danger" ? "rgba(248,113,113,.15)" : "hsl(218 35% 16%)";
  const color = variant === "primary" ? "hsl(144 80% 10%)" : variant === "danger" ? "#f87171" : "hsl(213 31% 75%)";
  return (
    <button {...props} style={{ padding: "8px 16px", borderRadius: 9, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit", background: bg, color, opacity: props.disabled ? 0.5 : 1, ...props.style }}>
      {children}
    </button>
  );
}
function Input({ ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...props} style={{ width: "100%", padding: "9px 12px", background: "hsl(222 47% 8%)", border: "1px solid hsl(218 35% 20%)", borderRadius: 9, color: "hsl(213 31% 88%)", fontSize: 14, outline: "none", fontFamily: "inherit", ...props.style }} />
  );
}

// ── Link sub-component (shown when session status === "qr") ───────────────────

function LinkPanel({ session, token }: { session: SessionInfo; token: string }) {
  const [method, setMethod]   = useState<"phone" | "qr">("phone");
  const [phone, setPhone]     = useState("");
  const [code, setCode]       = useState(session.pairingCode ?? "");
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState("");
  const [copied, setCopied]   = useState(false);
  const [qrTs, setQrTs]       = useState(Date.now());

  async function getCode() {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 7) { setErr("Enter your full number with country code — e.g. 14155551234"); return; }
    setLoading(true); setErr(""); setCode("");
    const res = await fetch(`${API}/sessions/${session.id}/pairing-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: digits }),
    });
    const d = await res.json();
    if (!res.ok) { setErr(d.error ?? "Failed"); }
    else         { setCode(d.code); }
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
        flex: 1, padding: "8px 0", border: "none", borderRadius: 7, cursor: "pointer",
        fontSize: 12, fontWeight: 600, fontFamily: "inherit",
        background: method === id ? "hsl(218 35% 22%)" : "transparent",
        color: method === id ? "hsl(213 31% 88%)" : "hsl(215 20% 42%)",
      }}
    >{label}</button>
  );

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid hsl(218 35% 15%)", paddingTop: 14 }}>
      <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "hsl(215 20% 42%)", marginBottom: 10 }}>Link WhatsApp</p>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 3, background: "hsl(222 47% 8%)", borderRadius: 9, padding: 3, marginBottom: 14 }}>
        {tabBtn("phone", "📱 Phone Number")}
        {tabBtn("qr",    "📷 QR Code"     )}
      </div>

      {/* Phone Number */}
      {method === "phone" && (
        <>
          <div style={{ display: "flex", gap: 7, marginBottom: 10 }}>
            <input
              type="tel"
              placeholder="e.g. 14155551234"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              onKeyDown={e => e.key === "Enter" && getCode()}
              style={{
                flex: 1, padding: "10px 12px", background: "hsl(222 47% 8%)",
                border: "1px solid hsl(218 35% 22%)", borderRadius: 9,
                color: "hsl(213 31% 88%)", fontSize: 15, outline: "none", fontFamily: "inherit",
              }}
              autoFocus
            />
            <button
              onClick={getCode}
              disabled={loading}
              style={{ padding: "10px 14px", borderRadius: 9, border: "none", cursor: "pointer", background: "hsl(142 72% 50%)", color: "hsl(144 80% 10%)", fontSize: 12, fontWeight: 700, fontFamily: "inherit", opacity: loading ? 0.6 : 1, flexShrink: 0 }}
            >{loading ? "…" : "Get Code"}</button>
          </div>

          {err && <p style={{ fontSize: 12, color: "#f87171", marginBottom: 10, padding: "7px 10px", background: "rgba(248,113,113,.08)", borderRadius: 7 }}>{err}</p>}

          {code && (
            <div>
              <p style={{ fontSize: 10, color: "hsl(215 20% 42%)", textTransform: "uppercase", letterSpacing: ".07em", fontWeight: 700, marginBottom: 6 }}>Pairing Code</p>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <div style={{
                  flex: 1, background: "hsl(222 47% 7%)", border: "2px solid hsl(142 72% 38%)",
                  borderRadius: 10, padding: "12px 16px", textAlign: "center",
                  fontFamily: "monospace", fontSize: 28, fontWeight: 800,
                  letterSpacing: "0.18em", color: "#f59e0b",
                }}>{code}</div>
                <button
                  onClick={copyCode}
                  style={{ padding: "12px 14px", borderRadius: 9, border: "none", cursor: "pointer", background: copied ? "hsl(142 72% 50%)" : "hsl(218 35% 18%)", color: copied ? "hsl(144 80% 10%)" : "hsl(213 31% 72%)", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}
                >{copied ? "✓" : "Copy"}</button>
              </div>
              <div style={{ background: "hsl(222 47% 8%)", borderRadius: 9, padding: 12 }}>
                {[
                  "Open WhatsApp on your phone",
                  "Tap ⋮ (Android) or Settings (iPhone)",
                  "Go to Linked Devices → Link a Device",
                  'Tap "Link with phone number instead"',
                  "Enter the code above",
                ].map((s, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                    <span style={{ width: 18, height: 18, borderRadius: "50%", background: "hsl(218 35% 20%)", color: "hsl(142 72% 60%)", fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</span>
                    <span style={{ fontSize: 11, color: "hsl(215 20% 52%)", lineHeight: 1.5 }}>{s}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!code && !loading && (
            <p style={{ fontSize: 11, color: "hsl(215 20% 38%)", lineHeight: 1.6 }}>
              Enter your number above → tap <strong style={{ color: "hsl(213 31% 68%)" }}>Get Code</strong> → enter the 8-character code in WhatsApp → Linked Devices → Link with phone number
            </p>
          )}
        </>
      )}

      {/* QR Code */}
      {method === "qr" && (
        <div style={{ textAlign: "center" }}>
          {session.hasQr ? (
            <>
              <img
                key={qrTs}
                src={`${API}/sessions/${session.id}/qr.png?t=${qrTs}`}
                alt="QR"
                width={200} height={200}
                style={{ borderRadius: 10, border: "1px solid hsl(218 35% 20%)", cursor: "pointer" }}
                onClick={() => setQrTs(Date.now())}
              />
              <p style={{ fontSize: 11, color: "#f59e0b", marginTop: 8 }}>
                WhatsApp → ⋮ → Linked Devices → Link a Device
              </p>
              <p style={{ fontSize: 10, color: "hsl(215 20% 36%)", marginTop: 4 }}>Tap QR to refresh</p>
            </>
          ) : (
            <p style={{ fontSize: 12, color: "hsl(215 20% 40%)", padding: "16px 0" }}>QR not ready yet — please wait…</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Session card ─────────────────────────────────────────────────────────────

function SessionCard({ session, token, onRefresh }: { session: SessionInfo; token: string; onRefresh: () => void }) {
  const [loading, setLoading] = useState(false);
  const cfg = STATUS[session.status];

  async function deleteSession() {
    if (!confirm(`Delete session "${session.label}"?`)) return;
    await fetch(`${API}/sessions/${session.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    onRefresh();
  }

  async function restartSession() {
    setLoading(true);
    await fetch(`${API}/sessions/${session.id}/restart`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    setLoading(false); onRefresh();
  }

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "hsl(213 31% 90%)" }}>{session.label}</div>
          <div style={{ fontSize: 11, color: "hsl(215 20% 38%)", marginTop: 2, fontFamily: "monospace" }}>{session.id}</div>
          {session.phoneNumber && (
            <div style={{ fontSize: 12, color: "hsl(215 20% 50%)", marginTop: 3 }}>+{session.phoneNumber}</div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
          <span style={{ padding: "4px 10px", borderRadius: 999, background: cfg.bg, color: cfg.color, fontSize: 12, fontWeight: 600 }}>{cfg.label}</span>
          <div style={{ display: "flex", gap: 6 }}>
            <Btn variant="ghost" onClick={restartSession} disabled={loading} style={{ padding: "5px 10px", fontSize: 11 }}>↺ Restart</Btn>
            {session.id !== "default" && (
              <Btn variant="danger" onClick={deleteSession} style={{ padding: "5px 10px", fontSize: 11 }}>✕ Delete</Btn>
            )}
          </div>
        </div>
      </div>

      {session.status === "qr" && <LinkPanel session={session} token={token} />}

      {session.log.length > 0 && (
        <div style={{ maxHeight: 100, overflowY: "auto", marginTop: 12, borderTop: "1px solid hsl(218 35% 14%)", paddingTop: 8 }}>
          {session.log.slice(0, 5).map((line, i) => (
            <div key={i} style={{ fontSize: 11, color: "hsl(215 20% 44%)", lineHeight: 1.6 }}>{line}</div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Sessions({ token }: { token: string }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading]   = useState(false);
  const [showAdd, setShowAdd]   = useState(false);
  const [newId, setNewId]       = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [err, setErr]           = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/sessions`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setSessions(await res.json());
    } catch { /* ignore */ }
  }, [token]);

  useEffect(() => {
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [load]);

  async function addSession() {
    const id = newId.trim().replace(/[^a-z0-9_-]/gi, "");
    if (!id) { setErr("ID must be alphanumeric"); return; }
    setLoading(true); setErr("");
    const res = await fetch(`${API}/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id, label: newLabel || id }),
    });
    const data = await res.json();
    if (!res.ok) { setErr(data.error ?? "Failed"); }
    else         { setShowAdd(false); setNewId(""); setNewLabel(""); load(); }
    setLoading(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "hsl(213 31% 88%)" }}>📱 Sessions ({sessions.length})</div>
        <Btn onClick={() => setShowAdd(!showAdd)}>+ Add Session</Btn>
      </div>

      {showAdd && (
        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: "hsl(215 20% 42%)", marginBottom: 12 }}>New Session</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Input placeholder="Session ID (e.g. work)" value={newId} onChange={(e) => setNewId(e.target.value)} />
            <Input placeholder="Label (e.g. Work Account)" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
            {err && <span style={{ fontSize: 12, color: "#f87171" }}>{err}</span>}
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={addSession} disabled={loading}>{loading ? "Starting…" : "Create & Start"}</Btn>
              <Btn variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Btn>
            </div>
          </div>
        </Card>
      )}

      {sessions.map((s) => (
        <SessionCard key={s.id} session={s} token={token} onRefresh={load} />
      ))}

      {sessions.length === 0 && (
        <Card>
          <p style={{ fontSize: 13, color: "hsl(215 20% 38%)", textAlign: "center" }}>No sessions found. The default session should appear after the bot starts.</p>
        </Card>
      )}
    </div>
  );
}
