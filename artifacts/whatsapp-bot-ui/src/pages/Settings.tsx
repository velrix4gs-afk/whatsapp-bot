import { useState, useEffect } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API = `${BASE}/api`;
const CACHE_KEY = "wa_bot_settings_cache_v1";

interface KeywordReply { keyword: string; reply: string; matchType: "exact" | "contains" }
interface Features {
  autoReact: boolean; saveStatus: boolean; savePP: boolean; viewOnce: boolean;
  saveProfile: boolean; antiDelete: boolean; autoDownloadStatus: boolean; antiLink: boolean;
  welcomeGoodbye: boolean; aiChat: boolean; customCommands: boolean; autoPresence: boolean;
}
interface SettingsData {
  features: Features; reactionEmojis: string[]; keywordReplies: KeywordReply[];
  welcomeMessage: string; goodbyeMessage: string; antiLinkWhitelist: string[]; aiSystemPrompt: string;
}
interface AuthStatus { anyUser: boolean; botConnected: boolean }
interface User { phone: string; label?: string; isOwner: boolean; lastLogin?: number; createdAt: number }
interface MediaItem { name: string; objectName: string; size: number; contentType: string; createdAt: string | null }

type LoginStep = "checking" | "login" | "register" | "settings";

const FEATURE_META: { key: keyof Features; icon: string; label: string; desc: string }[] = [
  { key: "autoReact",          icon: "🎲", label: "Auto-react Statuses",       desc: "React with a random emoji to every contact status" },
  { key: "autoDownloadStatus", icon: "💾", label: "Auto-download Statuses",     desc: "Automatically save all status photos/videos to disk" },
  { key: "saveStatus",         icon: "📥", label: ".save command",              desc: 'Reply to any status with ".save" → bot DMs you the media' },
  { key: "savePP",             icon: "🖼️", label: ".savepp command",            desc: 'Send ".savepp" to save a profile picture to your DM' },
  { key: "saveProfile",        icon: "📇", label: ".saveprofile command",       desc: 'Save any number\'s profile pic with ".saveprofile <number>"' },
  { key: "viewOnce",           icon: "🔓", label: "View-Once Capture",          desc: "React + save + forward view-once photos/videos to YOUR own DM" },
  { key: "antiDelete",         icon: "🚫", label: "Anti-Delete",               desc: "Repost deleted messages to the same chat" },
  { key: "antiLink",           icon: "🔗", label: "Anti-Link (Groups)",        desc: "Auto-delete messages containing links in groups" },
  { key: "welcomeGoodbye",     icon: "👋", label: "Welcome / Goodbye",         desc: "Auto-message when members join or leave groups" },
  { key: "aiChat",             icon: "🤖", label: "AI Chat Mode",              desc: 'Send ".ai on" in any chat to enable Gemini AI replies' },
  { key: "customCommands",     icon: "⌨️",  label: "Custom Commands",           desc: "Handle dot-prefix commands (e.g. .ping, .about)" },
  { key: "autoPresence",       icon: "✍️",  label: "Auto Typing / Recording",   desc: "Show typing indicator for ~60s after every incoming message" },
];

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: "hsl(222 47% 11%)", border: "1px solid hsl(218 35% 17%)", borderRadius: 14, padding: 22, ...style }}>{children}</div>;
}
function STitle({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: "hsl(215 20% 42%)", marginBottom: 14 }}>{children}</p>;
}
function Inp({ ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} style={{ width: "100%", padding: "11px 14px", background: "hsl(222 47% 8%)", border: "1px solid hsl(218 35% 20%)", borderRadius: 10, color: "hsl(213 31% 88%)", fontSize: 15, outline: "none", fontFamily: "inherit", ...props.style }} />;
}
function Btn({ children, variant = "primary", full, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger"; full?: boolean }) {
  const bg = variant === "primary" ? "hsl(142 72% 50%)" : variant === "danger" ? "rgba(248,113,113,.15)" : "hsl(218 35% 18%)";
  const color = variant === "primary" ? "hsl(144 80% 10%)" : variant === "danger" ? "#f87171" : "hsl(213 31% 75%)";
  return (
    <button {...props} style={{ width: full ? "100%" : undefined, padding: "12px 20px", borderRadius: 10, border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "inherit", background: bg, color, opacity: props.disabled ? 0.5 : 1, transition: "opacity .15s", ...props.style }}>
      {children}
    </button>
  );
}
function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{ width: 42, height: 24, borderRadius: 12, flexShrink: 0, background: on ? "hsl(142 72% 50%)" : "hsl(218 35% 22%)", position: "relative", cursor: "pointer", transition: "background .2s" }}>
      <div style={{ position: "absolute", top: 4, left: on ? 20 : 4, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left .2s", boxShadow: "0 1px 3px rgba(0,0,0,.4)" }} />
    </div>
  );
}
function Err({ msg }: { msg: string }) {
  return msg ? <p style={{ fontSize: 13, color: "#f87171", marginTop: 10, padding: "10px 14px", background: "rgba(248,113,113,.08)", borderRadius: 8 }}>{msg}</p> : null;
}

// ── localStorage cache helpers ───────────────────────────────────────────────
function readCache(): SettingsData | null {
  try { const raw = localStorage.getItem(CACHE_KEY); return raw ? JSON.parse(raw) as SettingsData : null; } catch { return null; }
}
function writeCache(d: SettingsData) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch { /* quota / private mode */ }
}

export default function Settings({ onBack, onLoggedIn }: { onBack: () => void; onLoggedIn?: (t: string) => void }) {
  const [step, setStep]         = useState<LoginStep>("checking");
  const [authStatus, setAS]     = useState<AuthStatus>({ anyUser: false, botConnected: false });
  const [token, setToken]       = useState(() => localStorage.getItem("bot_token") ?? "");
  const [phone, setPhone]       = useState(() => localStorage.getItem("bot_phone") ?? "");
  const [pin, setPin]           = useState("");
  const [pin2, setPin2]         = useState("");
  const [label, setLabel]       = useState("");
  const [me, setMe]             = useState<{ phone: string; isOwner: boolean } | null>(null);
  const [loading, setLoading]   = useState(false);
  const [err, setErr]           = useState("");
  const [data, setData]         = useState<SettingsData | null>(() => readCache());
  const [stale, setStale]       = useState(false);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [emojiInput, setEmojiInput] = useState("");
  const [activeTab, setActiveTab]   = useState<"features" | "keywords" | "groups" | "ai" | "emojis" | "security" | "users" | "media">("features");
  const [newKw, setNewKw]           = useState({ keyword: "", reply: "", matchType: "contains" as "exact" | "contains" });
  const [newPin, setNewPin]     = useState("");
  const [newPin2, setNewPin2]   = useState("");
  const [pinSaved, setPinSaved] = useState(false);
  const [users, setUsers]       = useState<User[]>([]);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaErr, setMediaErr] = useState("");

  useEffect(() => {
    (async () => {
      const as = await fetch(`${API}/settings/auth-status`).then(r => r.json()).catch(() => ({ anyUser: false, botConnected: false })) as AuthStatus;
      setAS(as);
      if (token) {
        const ok = await loadData(token);
        if (ok) return;
      }
      setStep(as.anyUser ? "login" : "register");
    })();
  }, []);

  // Auto-load media list when tab is opened
  useEffect(() => {
    if (activeTab === "media" && token && mediaItems.length === 0 && !mediaLoading) {
      loadMedia();
    }
  }, [activeTab, token]);

  async function loadData(tok: string): Promise<boolean> {
    try {
      const res = await fetch(`${API}/settings`, { headers: { Authorization: `Bearer ${tok}` } });
      if (res.status === 401) { localStorage.removeItem("bot_token"); setToken(""); setStale(true); return false; }
      const json: SettingsData = await res.json();
      setData(json);
      writeCache(json);
      setStale(false);
      setEmojiInput(json.reactionEmojis.join(" "));
      // Get current user info from the users list
      const usersRes = await fetch(`${API}/settings/users`, { headers: { Authorization: `Bearer ${tok}` } });
      if (usersRes.ok) {
        const ud = await usersRes.json() as { users: User[] };
        setUsers(ud.users);
        const myPhone = localStorage.getItem("bot_phone") ?? "";
        const meUser  = ud.users.find(u => u.phone === myPhone);
        if (meUser) setMe({ phone: meUser.phone, isOwner: meUser.isOwner });
      }
      setStep("settings");
      onLoggedIn?.(tok);
      return true;
    } catch {
      // Network failure → stay on cached data if we have it
      if (data) { setStale(true); setStep("settings"); onLoggedIn?.(tok); return true; }
      return false;
    }
  }

  function storeAuth(tok: string, ph: string) {
    localStorage.setItem("bot_token", tok);
    localStorage.setItem("bot_phone", ph);
    setToken(tok); setPhone(ph);
    onLoggedIn?.(tok);
  }

  async function loginWithPin() {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 7) { setErr("Enter your full phone number with country code"); return; }
    if (!pin) { setErr("Enter your PIN"); return; }
    setLoading(true); setErr("");
    const res = await fetch(`${API}/settings/pin-login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: digits, pin }),
    });
    const d = await res.json();
    if (!res.ok) { setErr(d.error ?? "Wrong number or PIN"); setLoading(false); return; }
    storeAuth(d.token, d.phone);
    await loadData(d.token);
    setLoading(false);
  }

  async function registerNew() {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 7) { setErr("Enter your full phone number with country code"); return; }
    if (pin.length < 4)    { setErr("PIN must be at least 4 characters"); return; }
    if (pin !== pin2)      { setErr("PINs do not match"); return; }
    setLoading(true); setErr("");
    const res = await fetch(`${API}/settings/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: digits, pin, label: label || undefined }),
    });
    const d = await res.json();
    if (!res.ok) { setErr(d.error ?? "Registration failed"); setLoading(false); return; }
    storeAuth(d.token, d.phone);
    setAS(prev => ({ ...prev, anyUser: true }));
    await loadData(d.token);
    setLoading(false);
  }

  async function changePin() {
    if (!newPin || newPin.length < 4) { setErr("PIN must be at least 4 characters"); return; }
    if (newPin !== newPin2)           { setErr("PINs do not match"); return; }
    setLoading(true); setErr("");
    const res = await fetch(`${API}/settings/set-pin`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ pin: newPin }),
    });
    const d = await res.json();
    if (!res.ok) { setErr(d.error ?? "Failed"); } else { setPinSaved(true); setNewPin(""); setNewPin2(""); setTimeout(() => setPinSaved(false), 3000); }
    setLoading(false);
  }

  async function loadMedia() {
    setMediaLoading(true); setMediaErr("");
    try {
      const res = await fetch(`${API}/media`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { const d = await res.json(); setMediaErr(d.error ?? "Failed to load media"); return; }
      const d = await res.json() as { items: MediaItem[] };
      setMediaItems(d.items);
    } catch { setMediaErr("Network error"); }
    finally { setMediaLoading(false); }
  }

  async function deleteMedia(objectName: string) {
    if (!confirm("Delete this file permanently?")) return;
    const res = await fetch(`${API}/media?file=${encodeURIComponent(objectName)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setMediaItems(prev => prev.filter(i => i.objectName !== objectName));
    else { const d = await res.json(); alert(d.error ?? "Delete failed"); }
  }

  function downloadMedia(objectName: string) {
    const a = document.createElement("a");
    a.href = `${API}/media/download?file=${encodeURIComponent(objectName)}`;
    a.setAttribute("download", "");
    // Pass auth via query param isn't ideal; use a hidden form-style trick instead
    fetch(`${API}/media/download?file=${encodeURIComponent(objectName)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.blob())
      .then(blob => {
        const url = URL.createObjectURL(blob);
        a.href = url; a.click(); URL.revokeObjectURL(url);
      })
      .catch(() => alert("Download failed"));
  }

  function fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function mediaTypeIcon(ct: string): string {
    if (ct.includes("image")) return "🖼️";
    if (ct.includes("video")) return "🎥";
    if (ct.includes("audio")) return "🎵";
    return "📁";
  }

  async function removeUser(p: string) {
    if (!confirm(`Remove user +${p}?`)) return;
    const res = await fetch(`${API}/settings/users/${p}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) { setUsers(users.filter(u => u.phone !== p)); }
    else { const d = await res.json(); alert(d.error); }
  }

  function logout() {
    localStorage.removeItem("bot_token");
    setToken(""); setData(null); setPin(""); setErr(""); setMe(null);
    setStep(authStatus.anyUser ? "login" : "register");
  }

  async function save() {
    if (!data) return;
    setSaving(true); setSaved(false);
    const emojis = emojiInput.split(/[\s,]+/).map(e => e.trim()).filter(Boolean);
    const updated = { ...data, reactionEmojis: emojis.length ? emojis : data.reactionEmojis };
    const res = await fetch(`${API}/settings`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(updated),
    });
    if (res.ok) { const d = await res.json(); setData(d.settings); writeCache(d.settings); setEmojiInput(d.settings.reactionEmojis.join(" ")); setSaved(true); setStale(false); setTimeout(() => setSaved(false), 2500); }
    else setErr("Failed to save.");
    setSaving(false);
  }
  function toggle(key: keyof Features) { if (!data) return; setData({ ...data, features: { ...data.features, [key]: !data.features[key] } }); }
  function removeKw(i: number) { if (!data) return; const kws = [...data.keywordReplies]; kws.splice(i, 1); setData({ ...data, keywordReplies: kws }); }
  function addKw() {
    if (!data || !newKw.keyword.trim() || !newKw.reply.trim()) return;
    setData({ ...data, keywordReplies: [...data.keywordReplies, { ...newKw }] });
    setNewKw({ keyword: "", reply: "", matchType: "contains" });
  }

  const subTab = (id: typeof activeTab, label: string) => (
    <button onClick={() => setActiveTab(id)} style={{ padding: "6px 14px", border: "none", borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit", background: activeTab === id ? "hsl(218 35% 22%)" : "transparent", color: activeTab === id ? "hsl(213 31% 88%)" : "hsl(215 20% 42%)" }}>{label}</button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700, color: "hsl(213 31% 91%)" }}>⚙️ Bot Settings</div>
          {step === "settings" && me && (
            <div style={{ fontSize: 12, color: "hsl(215 20% 42%)", marginTop: 3 }}>
              +{me.phone} {me.isOwner && <span style={{ color: "hsl(142 72% 60%)", marginLeft: 6 }}>★ Owner</span>}
              {stale && <span style={{ color: "#f59e0b", marginLeft: 8 }}>• cached (offline)</span>}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {step === "settings" && <Btn variant="ghost" onClick={logout} style={{ padding: "6px 12px", fontSize: 12 }}>Log out</Btn>}
          <Btn variant="ghost" onClick={onBack} style={{ padding: "6px 12px", fontSize: 12 }}>← Back</Btn>
        </div>
      </Card>

      {step === "checking" && (
        <Card><p style={{ fontSize: 13, color: "hsl(215 20% 48%)", textAlign: "center" }}>Checking login…</p></Card>
      )}

      {/* ── LOGIN ── */}
      {step === "login" && (
        <Card>
          <STitle>Log In</STitle>
          <p style={{ fontSize: 13, color: "hsl(215 20% 48%)", marginBottom: 18, lineHeight: 1.6 }}>
            Sign in with your phone number and PIN. Works from any device — WhatsApp does <strong style={{ color: "hsl(213 31% 78%)" }}>not</strong> need to be linked.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Inp type="tel" placeholder="Phone number with country code (e.g. 14155551234)" value={phone} onChange={e => setPhone(e.target.value)} autoFocus />
            <Inp type="password" placeholder="Your PIN" value={pin} onChange={e => setPin(e.target.value)} onKeyDown={e => e.key === "Enter" && loginWithPin()} style={{ letterSpacing: "0.18em", fontSize: 18 }} />
          </div>
          <Err msg={err} />
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <Btn full onClick={loginWithPin} disabled={loading}>{loading ? "Checking…" : "Log In"}</Btn>
            <Btn full variant="ghost" onClick={() => { setErr(""); setPin(""); setStep("register"); }}>+ Create new account</Btn>
          </div>
        </Card>
      )}

      {/* ── REGISTER ── */}
      {step === "register" && (
        <Card>
          <STitle>{authStatus.anyUser ? "Create New Account" : "First-Time Setup"}</STitle>
          <p style={{ fontSize: 13, color: "hsl(215 20% 48%)", marginBottom: 18, lineHeight: 1.6 }}>
            {authStatus.anyUser
              ? "Add a new dashboard user. Each user logs in with their own phone + PIN."
              : "You're the first user — you'll automatically become the bot owner. WhatsApp doesn't need to be linked yet."}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Inp type="tel" placeholder="Phone number with country code (e.g. 14155551234)" value={phone} onChange={e => setPhone(e.target.value)} autoFocus />
            <Inp type="text" placeholder="Display name (optional)" value={label} onChange={e => setLabel(e.target.value)} />
            <Inp type="password" placeholder="Choose a PIN (min 4 characters)" value={pin} onChange={e => setPin(e.target.value)} />
            <Inp type="password" placeholder="Confirm PIN" value={pin2} onChange={e => setPin2(e.target.value)} onKeyDown={e => e.key === "Enter" && registerNew()} />
          </div>
          <Err msg={err} />
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <Btn full onClick={registerNew} disabled={loading}>{loading ? "Creating…" : "Create Account & Log In →"}</Btn>
            {authStatus.anyUser && <Btn full variant="ghost" onClick={() => { setErr(""); setPin(""); setPin2(""); setStep("login"); }}>← Back to log in</Btn>}
          </div>
          <p style={{ fontSize: 11, color: "hsl(215 20% 30%)", marginTop: 12, lineHeight: 1.6 }}>
            🔒 Your PIN is hashed and stored on the server. Anyone with your phone + PIN can change bot settings.
          </p>
        </Card>
      )}

      {/* ── SETTINGS ── */}
      {step === "settings" && data && (
        <>
          {stale && (
            <Card style={{ background: "rgba(245,158,11,.08)", borderColor: "rgba(245,158,11,.3)" }}>
              <p style={{ fontSize: 12, color: "#f59e0b" }}>⚠️ Showing cached data — server is unreachable. Changes will fail until reconnected.</p>
            </Card>
          )}

          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", background: "hsl(222 47% 11%)", border: "1px solid hsl(218 35% 17%)", borderRadius: 12, padding: 4 }}>
            {subTab("features",  "Features")}
            {subTab("emojis",    "Emojis")}
            {subTab("keywords",  "Keywords")}
            {subTab("groups",    "Groups")}
            {subTab("ai",        "AI")}
            {subTab("users",     `Users (${users.length})`)}
            {subTab("security",  "Security")}
            {subTab("media",     "📂 Media")}
          </div>

          {activeTab === "features" && (
            <Card>
              <STitle>Feature Toggles</STitle>
              {FEATURE_META.map((f, i) => (
                <div key={f.key} onClick={() => toggle(f.key)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 0", borderBottom: i < FEATURE_META.length - 1 ? "1px solid hsl(218 35% 13%)" : "none", cursor: "pointer", userSelect: "none" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                    <span style={{ fontSize: 18, lineHeight: 1.3, flexShrink: 0 }}>{f.icon}</span>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "hsl(213 31% 88%)", marginBottom: 2 }}>{f.label}</div>
                      <div style={{ fontSize: 11, color: "hsl(215 20% 40%)", lineHeight: 1.5 }}>{f.desc}</div>
                    </div>
                  </div>
                  <Toggle on={data.features[f.key]} onClick={() => toggle(f.key)} />
                </div>
              ))}
            </Card>
          )}

          {activeTab === "emojis" && (
            <Card>
              <STitle>Reaction Emoji Pool</STitle>
              <p style={{ fontSize: 12, color: "hsl(215 20% 42%)", marginBottom: 12, lineHeight: 1.5 }}>Emojis used for auto-reacting to statuses. Separate with spaces.</p>
              <textarea value={emojiInput} onChange={e => setEmojiInput(e.target.value)} rows={4} style={{ width: "100%", padding: "10px 13px", background: "hsl(222 47% 8%)", border: "1px solid hsl(218 35% 20%)", borderRadius: 9, color: "hsl(213 31% 88%)", fontSize: 22, outline: "none", resize: "vertical", fontFamily: "inherit", lineHeight: 1.8 }} />
              <p style={{ fontSize: 11, color: "hsl(215 20% 30%)", marginTop: 6 }}>{emojiInput.split(/\s+/).filter(Boolean).length} emoji(s)</p>
            </Card>
          )}

          {activeTab === "keywords" && (
            <Card>
              <STitle>Keyword Auto-Replies</STitle>
              {data.keywordReplies.map((kw, i) => (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 0", borderBottom: "1px solid hsl(218 35% 13%)" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: "hsl(142 72% 60%)", fontWeight: 600 }}>{kw.matchType === "exact" ? "= " : "~ "}"{kw.keyword}"</div>
                    <div style={{ fontSize: 12, color: "hsl(215 20% 60%)", marginTop: 3 }}>→ {kw.reply}</div>
                  </div>
                  <button onClick={() => removeKw(i)} style={{ background: "rgba(248,113,113,.12)", color: "#f87171", border: "none", padding: "4px 10px", borderRadius: 6, cursor: "pointer", fontSize: 11 }}>✕</button>
                </div>
              ))}
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14, padding: 12, background: "hsl(222 47% 8%)", borderRadius: 10 }}>
                <Inp placeholder="Keyword to match" value={newKw.keyword} onChange={e => setNewKw({ ...newKw, keyword: e.target.value })} />
                <Inp placeholder="Reply message" value={newKw.reply} onChange={e => setNewKw({ ...newKw, reply: e.target.value })} />
                <div style={{ display: "flex", gap: 8 }}>
                  <select value={newKw.matchType} onChange={e => setNewKw({ ...newKw, matchType: e.target.value as "exact" | "contains" })} style={{ padding: "9px 12px", background: "hsl(222 47% 6%)", border: "1px solid hsl(218 35% 20%)", borderRadius: 8, color: "hsl(213 31% 88%)", fontSize: 13, fontFamily: "inherit" }}>
                    <option value="contains">Contains</option>
                    <option value="exact">Exact match</option>
                  </select>
                  <Btn onClick={addKw} style={{ flex: 1 }}>+ Add</Btn>
                </div>
              </div>
            </Card>
          )}

          {activeTab === "groups" && (
            <Card>
              <STitle>Group Settings</STitle>
              <p style={{ fontSize: 12, color: "hsl(215 20% 42%)", marginBottom: 6 }}>Welcome message ({"{name}"} for member name)</p>
              <Inp value={data.welcomeMessage} onChange={e => setData({ ...data, welcomeMessage: e.target.value })} />
              <p style={{ fontSize: 12, color: "hsl(215 20% 42%)", marginTop: 14, marginBottom: 6 }}>Goodbye message</p>
              <Inp value={data.goodbyeMessage} onChange={e => setData({ ...data, goodbyeMessage: e.target.value })} />
              <p style={{ fontSize: 12, color: "hsl(215 20% 42%)", marginTop: 14, marginBottom: 6 }}>Anti-link whitelist (one URL pattern per line)</p>
              <textarea value={data.antiLinkWhitelist.join("\n")} onChange={e => setData({ ...data, antiLinkWhitelist: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) })} rows={4} style={{ width: "100%", padding: "10px 13px", background: "hsl(222 47% 8%)", border: "1px solid hsl(218 35% 20%)", borderRadius: 9, color: "hsl(213 31% 88%)", fontSize: 13, outline: "none", resize: "vertical", fontFamily: "monospace" }} />
            </Card>
          )}

          {activeTab === "ai" && (
            <Card>
              <STitle>AI System Prompt</STitle>
              <p style={{ fontSize: 12, color: "hsl(215 20% 42%)", marginBottom: 10 }}>The personality / instructions Gemini uses when AI Chat is enabled.</p>
              <textarea value={data.aiSystemPrompt} onChange={e => setData({ ...data, aiSystemPrompt: e.target.value })} rows={6} style={{ width: "100%", padding: "10px 13px", background: "hsl(222 47% 8%)", border: "1px solid hsl(218 35% 20%)", borderRadius: 9, color: "hsl(213 31% 88%)", fontSize: 13, outline: "none", resize: "vertical", fontFamily: "inherit", lineHeight: 1.6 }} />
            </Card>
          )}

          {activeTab === "users" && (
            <Card>
              <STitle>Dashboard Users</STitle>
              {users.map(u => (
                <div key={u.phone} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderBottom: "1px solid hsl(218 35% 13%)" }}>
                  <div>
                    <div style={{ fontSize: 14, color: "hsl(213 31% 88%)", fontWeight: 600 }}>
                      +{u.phone} {u.isOwner && <span style={{ color: "hsl(142 72% 60%)", fontSize: 11, marginLeft: 6 }}>★ Owner</span>}
                      {me?.phone === u.phone && <span style={{ color: "hsl(215 20% 50%)", fontSize: 11, marginLeft: 6 }}>(you)</span>}
                    </div>
                    {u.label && <div style={{ fontSize: 12, color: "hsl(215 20% 50%)", marginTop: 2 }}>{u.label}</div>}
                    <div style={{ fontSize: 11, color: "hsl(215 20% 36%)", marginTop: 2 }}>
                      Last login: {u.lastLogin ? new Date(u.lastLogin).toLocaleString() : "never"}
                    </div>
                  </div>
                  {me?.isOwner && me.phone !== u.phone && (
                    <button onClick={() => removeUser(u.phone)} style={{ background: "rgba(248,113,113,.12)", color: "#f87171", border: "none", padding: "5px 10px", borderRadius: 6, cursor: "pointer", fontSize: 11 }}>Remove</button>
                  )}
                </div>
              ))}
              <p style={{ fontSize: 11, color: "hsl(215 20% 36%)", marginTop: 14, lineHeight: 1.6 }}>
                Anyone can register a new account from the login screen using their own phone + PIN. Only the owner can remove other users.
              </p>
            </Card>
          )}

          {activeTab === "security" && (
            <Card>
              <STitle>Change Your PIN</STitle>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <Inp type="password" placeholder="New PIN (min 4 characters)" value={newPin} onChange={e => setNewPin(e.target.value)} />
                <Inp type="password" placeholder="Confirm new PIN" value={newPin2} onChange={e => setNewPin2(e.target.value)} />
              </div>
              <Err msg={err} />
              {pinSaved && <p style={{ fontSize: 13, color: "hsl(142 72% 60%)", marginTop: 10 }}>✓ PIN updated</p>}
              <div style={{ marginTop: 14 }}>
                <Btn onClick={changePin} disabled={loading}>Save New PIN</Btn>
              </div>
            </Card>
          )}

          {activeTab === "media" && (
            <Card>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <STitle style={{ marginBottom: 0 }}>Saved Media Library</STitle>
                <Btn variant="ghost" onClick={loadMedia} disabled={mediaLoading} style={{ padding: "5px 12px", fontSize: 12 }}>
                  {mediaLoading ? "Loading…" : "↻ Refresh"}
                </Btn>
              </div>
              <p style={{ fontSize: 12, color: "hsl(215 20% 42%)", marginBottom: 14, lineHeight: 1.6 }}>
                All view-once photos/videos captured by the bot are saved here permanently. Download them or delete to free space.
              </p>
              {mediaErr && <Err msg={mediaErr} />}
              {!mediaLoading && mediaItems.length === 0 && !mediaErr && (
                <div style={{ textAlign: "center", padding: "32px 0", color: "hsl(215 20% 36%)", fontSize: 13 }}>
                  <div style={{ fontSize: 32, marginBottom: 10 }}>📭</div>
                  No media saved yet. Send a view-once to the bot — it will appear here.
                  <br /><br />
                  <Btn variant="ghost" onClick={loadMedia} style={{ fontSize: 12, padding: "6px 14px" }}>Load Media</Btn>
                </div>
              )}
              {mediaItems.length > 0 && (
                <>
                  <div style={{ fontSize: 11, color: "hsl(215 20% 36%)", marginBottom: 12 }}>
                    {mediaItems.length} file{mediaItems.length !== 1 ? "s" : ""} — click to download, ✕ to delete
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {mediaItems.map((item) => (
                      <div key={item.objectName} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", background: "hsl(222 47% 8%)", borderRadius: 10, border: "1px solid hsl(218 35% 16%)" }}>
                        <span style={{ fontSize: 22, flexShrink: 0 }}>{mediaTypeIcon(item.contentType)}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, color: "hsl(213 31% 85%)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</div>
                          <div style={{ fontSize: 11, color: "hsl(215 20% 40%)", marginTop: 2 }}>
                            {fmtSize(item.size)}
                            {item.createdAt && <> · {new Date(item.createdAt).toLocaleString()}</>}
                          </div>
                        </div>
                        <button
                          onClick={() => downloadMedia(item.objectName)}
                          title="Download"
                          style={{ background: "hsl(218 35% 18%)", color: "hsl(213 31% 75%)", border: "none", padding: "6px 12px", borderRadius: 7, cursor: "pointer", fontSize: 13, flexShrink: 0 }}
                        >⬇</button>
                        <button
                          onClick={() => deleteMedia(item.objectName)}
                          title="Delete"
                          style={{ background: "rgba(248,113,113,.12)", color: "#f87171", border: "none", padding: "6px 12px", borderRadius: 7, cursor: "pointer", fontSize: 13, flexShrink: 0 }}
                        >✕</button>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 16, fontSize: 11, color: "hsl(215 20% 30%)", lineHeight: 1.6 }}>
                    💡 Tip: files are sorted newest-first. All files count toward your cloud storage quota.
                  </div>
                </>
              )}
            </Card>
          )}

          {/* Save button (shown for tabs that edit data) */}
          {(activeTab === "features" || activeTab === "emojis" || activeTab === "keywords" || activeTab === "groups" || activeTab === "ai") && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "flex-end" }}>
              {saved && <span style={{ fontSize: 12, color: "hsl(142 72% 60%)" }}>✓ Saved</span>}
              <Btn onClick={save} disabled={saving}>{saving ? "Saving…" : "💾 Save Changes"}</Btn>
            </div>
          )}
        </>
      )}
    </div>
  );
}
