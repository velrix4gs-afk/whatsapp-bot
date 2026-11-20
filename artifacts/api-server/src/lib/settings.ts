import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;

// Use workspace dir — persistent in Replit Autoscale (os.homedir() is ephemeral)
const BASE_DIR = path.join(process.cwd(), "data");
const SETTINGS_FILE = path.join(BASE_DIR, "settings.json");
const AUTH_FILE = path.join(BASE_DIR, "auth.json");

// ── Lazy DB pool (gracefully skipped when DATABASE_URL is absent) ─────────────

let _pool: pg.Pool | null = null;
function getPool(): pg.Pool | null {
  if (_pool) return _pool;
  if (!process.env["DATABASE_URL"]) return null;
  _pool = new Pool({ connectionString: process.env["DATABASE_URL"], max: 5 });
  _pool.on("error", () => { /* ignore idle client errors */ });
  return _pool;
}

export async function dbQuery(sql: string, params: unknown[] = []): Promise<pg.QueryResult | null> {
  try {
    const pool = getPool();
    if (!pool) return null;
    return await pool.query(sql, params);
  } catch {
    return null;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KeywordReply {
  keyword: string;
  reply: string;
  matchType: "exact" | "contains";
}

export type AiMatchType = "exact" | "contains" | "startsWith" | "endsWith" | "regex";

export interface AiRule {
  id: string;
  trigger: string;
  response: string;
  matchType: AiMatchType;
  enabled: boolean;
  createdAt: number;
}

export type AiProviderKind =
  | "ai21" | "cohere" | "dashscope" | "modelscope" | "nvidia"
  | "ollama" | "openrouter" | "gemini" | "groq" | "mistral"
  | "custom" | "openai" | "anthropic";

export interface AiProviderConfig {
  id: string;
  provider: AiProviderKind;
  apiKey: string;
  model: string;
  baseUrl?: string;
  label?: string;
}

export interface ProviderPreset {
  label: string;
  kind: AiProviderKind;
  baseUrl: string;
  defaultModel: string;
  requiresKey: boolean;
  hint: string;
}

/** Every provider NovaBot supports. All but gemini/anthropic speak the OpenAI chat-completions dialect. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { kind: "ai21", label: "AI21 Labs", baseUrl: "https://api.ai21.com/studio/v1", defaultModel: "jamba-mini", requiresKey: true, hint: "Get a key at studio.ai21.com" },
  { kind: "cohere", label: "Cohere", baseUrl: "https://api.cohere.com/compatibility/v1", defaultModel: "command-r7b-12-2024", requiresKey: true, hint: "dashboard.cohere.com → API keys" },
  { kind: "dashscope", label: "DashScope (Alibaba Qwen)", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-plus", requiresKey: true, hint: "dashscope.console.aliyun.com → API key" },
  { kind: "modelscope", label: "ModelScope", baseUrl: "https://api-inference.modelscope.cn/v1", defaultModel: "Qwen/Qwen2.5-72B-Instruct", requiresKey: true, hint: "modelscope.cn → access token" },
  { kind: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", defaultModel: "meta/llama-3.3-70b-instruct", requiresKey: true, hint: "build.nvidia.com → nvapi-… key" },
  { kind: "ollama", label: "Ollama (local / tunnel)", baseUrl: "http://127.0.0.1:11434/v1", defaultModel: "llama3.2", requiresKey: false, hint: "Run on your PC, expose with cloudflared/ngrok, paste the public URL" },
  { kind: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "meta-llama/llama-3.3-70b-instruct:free", requiresKey: true, hint: "openrouter.ai/keys" },
  { kind: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-2.5-flash", requiresKey: true, hint: "aistudio.google.com → API key" },
  { kind: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile", requiresKey: true, hint: "console.groq.com/keys" },
  { kind: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", defaultModel: "mistral-small-latest", requiresKey: true, hint: "console.mistral.ai → API keys" },
  { kind: "custom", label: "Custom (OpenAI-compatible)", baseUrl: "", defaultModel: "", requiresKey: false, hint: "Any OpenAI-compatible endpoint (FreeLLM, vLLM, LM Studio…)" },
];

export function providerPreset(kind: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(p => p.kind === kind);
}

export interface AiPersona {
  id: string;
  name: string;
  instructions: string;
  providerId?: string;
}

export interface BotFeatures {
  autoReact: boolean;
  saveStatus: boolean;
  savePP: boolean;
  viewOnce: boolean;
  saveProfile: boolean;
  antiDelete: boolean;
  autoDownloadStatus: boolean;
  antiLink: boolean;
  welcomeGoodbye: boolean;
  aiChat: boolean;
  customCommands: boolean;
  autoPresence: boolean;
  memory: boolean;
  replyMode: "only" | "all";
}

export interface BotSettings {
  features: BotFeatures;
  reactionEmojis: string[];
  keywordReplies: KeywordReply[];
  welcomeMessage: string;
  goodbyeMessage: string;
  antiLinkWhitelist: string[];
  aiSystemPrompt: string;
  adminNumber: string;
  aiProviders: AiProviderConfig[];
  aiRules: AiRule[];
  defaultAiProvider: string;
  personas: AiPersona[];
  publicUrl: string;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: BotSettings = {
  features: {
    autoReact: true,
    saveStatus: true,
    savePP: true,
    viewOnce: true,
    saveProfile: true,
    antiDelete: false,
    autoDownloadStatus: false,
    antiLink: false,
    welcomeGoodbye: false,
    aiChat: true,
    customCommands: true,
    autoPresence: true,
    memory: true,
    replyMode: "all",
  },
  reactionEmojis: [
    "❤️", "🔥", "😍", "🥰", "😂", "👏", "🎉", "💯", "✨", "😊",
    "🙌", "💪", "😎", "🫶", "💥", "🤩", "😁", "❤️‍🔥", "🥳", "👀",
  ],
  keywordReplies: [],
  welcomeMessage: "👋 Welcome {name}! Glad to have you here.",
  goodbyeMessage: "👋 {name} has left the group. Goodbye!",
  antiLinkWhitelist: [],
  aiSystemPrompt: "You are a helpful WhatsApp assistant. Keep responses short and friendly.",
  adminNumber: "2348103077073",
  aiProviders: [],
  aiRules: [],
  defaultAiProvider: "",
  personas: [],
  publicUrl: "",
};

// ── Settings persistence ──────────────────────────────────────────────────────

function readSettingsFile(): BotSettings | null {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Partial<BotSettings>;
      return { ...DEFAULT_SETTINGS, ...parsed, features: { ...DEFAULT_SETTINGS.features, ...parsed.features } };
    }
  } catch { /* ignore */ }
  return null;
}

function writeSettingsFile(s: BotSettings): void {
  try { fs.mkdirSync(BASE_DIR, { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); }
  catch { /* ignore */ }
}

export function loadSettings(): BotSettings {
  // Try to synchronously read from the file cache; DB load happens async in applySettings startup flow
  return readSettingsFile() ?? { ...DEFAULT_SETTINGS, features: { ...DEFAULT_SETTINGS.features } };
}

export async function loadSettingsFromDb(): Promise<BotSettings> {
  const row = await dbQuery("SELECT data FROM bot_settings WHERE id = 'default' LIMIT 1");
  if (row?.rows?.[0]?.data) {
    const parsed = row.rows[0].data as Partial<BotSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed, features: { ...DEFAULT_SETTINGS.features, ...parsed.features } };
  }
  // Fall back to file
  return readSettingsFile() ?? { ...DEFAULT_SETTINGS, features: { ...DEFAULT_SETTINGS.features } };
}

export function saveSettings(s: BotSettings): void {
  writeSettingsFile(s); // always sync-write file for fast local reads
  // Async DB write — fire-and-forget; failures are non-fatal
  dbQuery(
    "INSERT INTO bot_settings (id, data, updated_at) VALUES ('default', $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data = $1::jsonb, updated_at = now()",
    [JSON.stringify(s)]
  ).catch(() => { });
}

// Live singleton — refreshed from DB at startup and on each applySettings call
export let currentSettings: BotSettings = loadSettings();

export async function initSettings(): Promise<void> {
  currentSettings = await loadSettingsFromDb();
  writeSettingsFile(currentSettings); // warm the file cache
}

export function applySettings(s: BotSettings): void {
  currentSettings = s;
  saveSettings(s);
}

/** Pick the configured default AI provider, falling back to the first one. */
export function getActiveAiProvider(s: BotSettings): AiProviderConfig | null {
  if (!s.aiProviders?.length) return null;
  return s.aiProviders.find(p => p.id === s.defaultAiProvider) ?? s.aiProviders[0];
}

/**
 * Ordered failover pool: preferred provider first, then the default, then the rest.
 * callAiWithPool() walks this list and silently switches on failure.
 */
export function getProviderPool(s: BotSettings, preferredId?: string): AiProviderConfig[] {
  const all = (s.aiProviders ?? []).filter(p => p?.id);
  const pool: AiProviderConfig[] = [];
  const push = (p?: AiProviderConfig | null) => {
    if (p && !pool.some(x => x.id === p.id)) pool.push(p);
  };
  if (preferredId) push(all.find(p => p.id === preferredId));
  push(all.find(p => p.id === s.defaultAiProvider));
  for (const p of all) push(p);
  return pool;
}

/** Find a persona by name (case-insensitive). */
export function getPersona(s: BotSettings, name: string): AiPersona | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  return (s.personas ?? []).find(p => p.name.trim().toLowerCase() === n) ?? null;
}

/** Provider for a persona, falling back to the default provider. */
export function getPersonaProvider(s: BotSettings, persona: AiPersona | null): AiProviderConfig | null {
  if (persona?.providerId) {
    const p = (s.aiProviders ?? []).find(x => x.id === persona.providerId);
    if (p) return p;
  }
  return getActiveAiProvider(s);
}

// ── Multi-user PIN auth ───────────────────────────────────────────────────────

interface DashboardUser {
  phone: string;
  pinHash: string;
  label?: string;
  isOwner: boolean;
  createdAt: number;
  lastLogin?: number;
}

interface AuthData {
  pinHash?: string;  // legacy field
  users?: DashboardUser[];
}

function hashPin(phone: string, pin: string): string {
  return crypto.createHash("sha256").update(`wa-bot:${phone}:${pin}`).digest("hex");
}
function legacyHashPin(pin: string): string {
  return crypto.createHash("sha256").update(`wa-bot-pin:${pin}`).digest("hex");
}
function normalizePhone(phone: string): string {
  return String(phone ?? "").replace(/\D/g, "");
}

// ── File-based auth fallback (legacy + offline) ───────────────────────────────

function loadAuthFile(): AuthData {
  try {
    if (fs.existsSync(AUTH_FILE)) return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")) as AuthData;
  } catch { /* ignore */ }
  return {};
}

function saveAuthFile(data: AuthData): void {
  try { fs.mkdirSync(BASE_DIR, { recursive: true }); fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2)); }
  catch { /* ignore */ }
}

/** File-cache fallback so login works even when no database is configured. */
function fileGetUser(phone: string): DashboardUser | null {
  const auth = loadAuthFile();
  return (auth.users ?? []).find(u => u.phone === phone) ?? null;
}

function fileDeleteUser(phone: string): boolean {
  const auth = loadAuthFile();
  const before = (auth.users ?? []).length;
  auth.users = (auth.users ?? []).filter(u => u.phone !== phone);
  saveAuthFile(auth);
  return auth.users.length < before;
}

// ── DB-backed auth ────────────────────────────────────────────────────────────

async function dbGetUser(phone: string): Promise<DashboardUser | null> {
  const r = await dbQuery("SELECT phone, pin_hash, label, is_owner, created_at, last_login FROM bot_auth_users WHERE phone = $1", [phone]);
  if (!r?.rows?.[0]) return null;
  const u = r.rows[0] as { phone: string; pin_hash: string; label?: string; is_owner: boolean; created_at: string; last_login?: string };
  return { phone: u.phone, pinHash: u.pin_hash, label: u.label, isOwner: u.is_owner, createdAt: Number(u.created_at), lastLogin: u.last_login ? Number(u.last_login) : undefined };
}

async function dbListUsers(): Promise<DashboardUser[]> {
  const r = await dbQuery("SELECT phone, pin_hash, label, is_owner, created_at, last_login FROM bot_auth_users ORDER BY created_at ASC");
  if (!r?.rows) return [];
  return r.rows.map((u: { phone: string; pin_hash: string; label?: string; is_owner: boolean; created_at: string; last_login?: string }) => ({
    phone: u.phone, pinHash: u.pin_hash, label: u.label ?? undefined,
    isOwner: u.is_owner, createdAt: Number(u.created_at),
    lastLogin: u.last_login ? Number(u.last_login) : undefined,
  }));
}

async function dbCountUsers(): Promise<number> {
  const r = await dbQuery("SELECT COUNT(*) as cnt FROM bot_auth_users");
  return Number(r?.rows?.[0]?.cnt ?? 0);
}

async function dbUpsertUser(u: DashboardUser): Promise<void> {
  await dbQuery(
    "INSERT INTO bot_auth_users (phone, pin_hash, label, is_owner, created_at, last_login) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (phone) DO UPDATE SET pin_hash=$2, label=$3, is_owner=$4, last_login=$6",
    [u.phone, u.pinHash, u.label ?? null, u.isOwner, u.createdAt, u.lastLogin ?? null]
  );
  // Also write to file cache
  const auth = loadAuthFile();
  auth.users ??= [];
  const idx = auth.users.findIndex(x => x.phone === u.phone);
  if (idx >= 0) auth.users[idx] = u; else auth.users.push(u);
  saveAuthFile(auth);
}

async function dbDeleteUser(phone: string): Promise<boolean> {
  const r = await dbQuery("DELETE FROM bot_auth_users WHERE phone = $1", [phone]);
  if ((r?.rowCount ?? 0) > 0) {
    const auth = loadAuthFile();
    auth.users = (auth.users ?? []).filter(u => u.phone !== phone);
    saveAuthFile(auth);
    return true;
  }
  return false;
}

// ── Migrate legacy file-based auth to DB (runs on first login) ───────────────

async function tryMigrateLegacyToDb(): Promise<void> {
  const auth = loadAuthFile();
  if (!auth.users?.length) return;
  for (const u of auth.users) {
    const existing = await dbGetUser(u.phone);
    if (!existing) await dbUpsertUser(u);
  }
}

// ── Public auth API ───────────────────────────────────────────────────────────

export async function hasDashboardPinAsync(): Promise<boolean> {
  const count = await dbCountUsers();
  if (count > 0) return true;
  const auth = loadAuthFile();
  return (auth.users && auth.users.length > 0) || !!auth.pinHash;
}

export function hasDashboardPin(): boolean {
  // Synchronous check for route handlers — file only
  const auth = loadAuthFile();
  return (auth.users && auth.users.length > 0) || !!auth.pinHash;
}

export async function listUsers(): Promise<{ phone: string; label?: string; isOwner: boolean; lastLogin?: number; createdAt: number }[]> {
  await tryMigrateLegacyToDb();
  const users = await dbListUsers();
  if (users.length > 0) return users.map(u => ({ phone: u.phone, label: u.label, isOwner: u.isOwner, lastLogin: u.lastLogin, createdAt: u.createdAt }));
  // Fall back to file
  const auth = loadAuthFile();
  return (auth.users ?? []).map(u => ({ phone: u.phone, label: u.label, isOwner: u.isOwner, lastLogin: u.lastLogin, createdAt: u.createdAt }));
}

export async function registerUser(phone: string, pin: string, label?: string): Promise<{ ok: boolean; error?: string; isOwner?: boolean }> {
  const normalized = normalizePhone(phone);
  if (normalized.length < 7) return { ok: false, error: "Invalid phone number" };
  if (!pin || pin.length < 4) return { ok: false, error: "PIN must be at least 4 characters" };

  await tryMigrateLegacyToDb();
  const existing = (await dbGetUser(normalized)) ?? fileGetUser(normalized);
  if (existing) return { ok: false, error: "A user with this phone number already exists. Use 'Log In' instead." };

  const count = await dbCountUsers();
  const fileCount = (loadAuthFile().users ?? []).length;
  const isOwner = count === 0 && fileCount === 0;
  const user: DashboardUser = { phone: normalized, pinHash: hashPin(normalized, pin), label, isOwner, createdAt: Date.now() };
  await dbUpsertUser(user);
  return { ok: true, isOwner };
}

export async function changeUserPin(phone: string, newPin: string): Promise<boolean> {
  const normalized = normalizePhone(phone);
  if (!newPin || newPin.length < 4) return false;
  const user = (await dbGetUser(normalized)) ?? fileGetUser(normalized);
  if (!user) return false;
  user.pinHash = hashPin(normalized, newPin);
  await dbUpsertUser(user);
  return true;
}

export async function deleteUser(phone: string): Promise<boolean> {
  const normalized = normalizePhone(phone);
  const dbDeleted = await dbDeleteUser(normalized);
  const fileDeleted = fileDeleteUser(normalized);
  return dbDeleted || fileDeleted;
}

export async function verifyPinAndCreateSession(phone: string, pin: string): Promise<{ token: string; isOwner: boolean; phone: string } | null> {
  const normalized = normalizePhone(phone);
  await tryMigrateLegacyToDb();

  let user = (await dbGetUser(normalized)) ?? fileGetUser(normalized);

  // Legacy migration: if no DB user but a legacy pinHash file exists and matches
  if (!user) {
    const auth = loadAuthFile();
    if (auth.pinHash && auth.pinHash === legacyHashPin(pin)) {
      const isOwner = (await dbCountUsers()) === 0;
      const newUser: DashboardUser = { phone: normalized, pinHash: hashPin(normalized, pin), isOwner, createdAt: Date.now() };
      await dbUpsertUser(newUser);
      const updatedAuth = loadAuthFile();
      delete updatedAuth.pinHash;
      saveAuthFile(updatedAuth);
      user = newUser;
    }
  }

  if (!user) return null;
  if (user.pinHash !== hashPin(normalized, pin)) return null;

  user.lastLogin = Date.now();
  await dbUpsertUser(user);

  const token = crypto.randomBytes(32).toString("hex");
  // Persist session to DB so it survives restarts
  await dbQuery(
    "INSERT INTO bot_session_tokens (token, phone, expires_at) VALUES ($1, $2, $3) ON CONFLICT (token) DO UPDATE SET phone=$2, expires_at=$3",
    [token, normalized, Date.now() + 7 * 24 * 60 * 60_000]
  );
  sessionStore.set(token, { phone: normalized, isOwner: user.isOwner, expiresAt: Date.now() + 7 * 24 * 60 * 60_000 });
  return { token, isOwner: user.isOwner, phone: normalized };
}

// Deprecated — kept so old code doesn't break at compile time
export function setDashboardPin(_pin: string): void { /* deprecated */ }

// ── OTP store (in-memory, short-lived — no persistence needed) ────────────────

interface OtpEntry { code: string; phone: string; expiresAt: number }
const otpStore = new Map<string, OtpEntry>();

export function createOtp(phone: string): string {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(phone, { code, phone, expiresAt: Date.now() + 5 * 60_000 });
  return code;
}

// ── Session store (in-memory write-through to DB) ─────────────────────────────

export interface Session { phone: string; isOwner: boolean; expiresAt: number }
const sessionStore = new Map<string, Session>();

export function isOwnerPhone(phone: string): boolean {
  const normalized = normalizePhone(phone);
  return (fileGetUser(normalized) ?? null)?.isOwner === true;
}

export async function loadSessionsFromDb(): Promise<void> {
  const r = await dbQuery("DELETE FROM bot_session_tokens WHERE expires_at < $1; SELECT token, phone, expires_at FROM bot_session_tokens", [Date.now()]);
  // The above is two statements so we get only the SELECT result on some drivers
  const r2 = await dbQuery("SELECT token, phone, expires_at FROM bot_session_tokens WHERE expires_at > $1", [Date.now()]);
  if (r2?.rows) {
    for (const row of r2.rows as { token: string; phone: string; expires_at: string }[]) {
      sessionStore.set(row.token, { phone: row.phone, isOwner: isOwnerPhone(row.phone), expiresAt: Number(row.expires_at) });
    }
  }
  void r; // silence unused warning
}

export function verifyOtpAndCreateSession(phone: string, code: string): string | null {
  const entry = otpStore.get(phone);
  if (!entry || entry.code !== code || Date.now() > entry.expiresAt) { otpStore.delete(phone); return null; }
  otpStore.delete(phone);
  const token = crypto.randomBytes(32).toString("hex");
  sessionStore.set(token, { phone, isOwner: isOwnerPhone(phone), expiresAt: Date.now() + 24 * 60 * 60_000 });
  return token;
}

export function getSession(token: string): Session | null {
  const s = sessionStore.get(token);
  if (!s || Date.now() > s.expiresAt) { sessionStore.delete(token); return null; }
  return s;
}
