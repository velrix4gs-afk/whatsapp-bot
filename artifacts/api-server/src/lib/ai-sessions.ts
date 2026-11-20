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
  lastActive?: number;
}

const FILE = path.join(process.cwd(), "data", "ai-sessions.json");
const MAX_HISTORY = 24;
/** A persona nobody talks to for this long quietly leaves the chat. */
const IDLE_MS = 45 * 60_000;

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

/** Persona chats are scoped to the linked bot, so two bots in the same group never share history. */
let scope = "";
export function setSessionScope(id: string): void {
  scope = id ? `${id}|` : "";
}
function k(jid: string): string {
  return scope + jid;
}

export function getActiveSession(jid: string): Session | null {
  const store = read();
  const key = k(jid);
  const s = store[key];
  if (!s || !Array.isArray(s.history)) return null;
  // Stale sessions must not resurrect a conversation hours later.
  const last = s.lastActive ?? Date.parse(s.startedAt) ?? 0;
  if (Date.now() - last > IDLE_MS) {
    delete store[key];
    write(store);
    return null;
  }
  return s;
}

export function startSession(jid: string, persona: string): Session {
  const store = read();
  const key = k(jid);
  store[key] = { persona, history: [], startedAt: new Date().toISOString(), lastActive: Date.now() };
  write(store);
  return store[key]!;
}

export function appendToSession(jid: string, message: AiChatMessage): void {
  const store = read();
  const s = store[k(jid)];
  if (!s) return;
  s.history.push(message);
  if (s.history.length > MAX_HISTORY) s.history = s.history.slice(-MAX_HISTORY);
  s.lastActive = Date.now();
  write(store);
}

export function endSession(jid: string): Session | null {
  const store = read();
  const key = k(jid);
  const s = store[key] ?? null;
  if (s) delete store[key];
  write(store);
  return s;
}

/** Phrases that make the active persona leave the conversation. */
const STOP_WORDS = /^(enough|leave|stop|bye|goodbye|quit|that'?s all|no more|exit)\b/i;

export function isStopMessage(text: string, personaName: string): boolean {
  let t = text.trim().toLowerCase();
  if (!t) return false;
  t = t.replace(/^@/, "");
  const name = personaName.trim().toLowerCase();
  if (name && t.startsWith(name)) {
    t = t.slice(name.length).replace(/^[\s,:;.!?-]+/, "");
  }
  // "enough", "nora enough", "@nora leave", "stop" all dismiss the persona.
  return STOP_WORDS.test(t) || /\b(leave|enough|go away|stop)\b$/i.test(t);
}
