import fs from "fs";
import path from "path";

export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface Session {
  persona: string;          // persona name that joined the chat
  history: AiChatMessage[];
  startedAt: string;
}

const FILE = path.join(process.cwd(), "data", "ai-sessions.json");
const MAX_HISTORY = 24;

type Store = Record<string, Session>;

function read(): Store {
  try {
    if (!fs.existsSync(FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
  } catch { /* ignore */ }
}

export function getActiveSession(jid: string): Session | null {
  const s = read()[jid];
  return s && Array.isArray(s.history) ? s : null;
}

export function startSession(jid: string, persona: string): Session {
  const store = read();
  store[jid] = { persona, history: [], startedAt: new Date().toISOString() };
  write(store);
  return store[jid]!;
}

export function appendToSession(jid: string, message: AiChatMessage): void {
  const store = read();
  const s = store[jid];
  if (!s) return;
  s.history.push(message);
  if (s.history.length > MAX_HISTORY) s.history = s.history.slice(-MAX_HISTORY);
  write(store);
}

export function endSession(jid: string): Session | null {
  const store = read();
  const s = store[jid] ?? null;
  if (s) delete store[jid];
  write(store);
  return s;
}

/** Phrases that make the active persona leave the conversation. */
const STOP_WORDS = /\b(enough|leave|stop|bye|goodbye|quit|that'?s all|no more)\b/i;

export function isStopMessage(text: string, personaName: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  const name = personaName.trim().toLowerCase();
  const withoutName = t.startsWith(name) ? t.slice(name.length).replace(/^[\s,:;.!?-]+/, "") : t;
  return STOP_WORDS.test(withoutName);
}
