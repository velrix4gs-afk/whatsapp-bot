import fs from "fs";
import path from "path";
import { dbQuery, type BotSettings } from "./settings";
import { callAiWithPool } from "./ai";

/**
 * Per-contact memory for the AI: facts learned from past conversations, kept
 * separately for every linked bot (session) so each user only ever sees their
 * own contacts' memory.
 */

export interface MemoryTurn {
  role: "user" | "assistant";
  text: string;
  at: number;
}

export interface ContactMemory {
  summary: string;
  facts: string[];
  recent: MemoryTurn[];
  messageCount: number;
  updatedAt: number;
  lastLearnedCount: number;
}

const MAX_RECENT = 40;
const MAX_FACTS = 15;
const LEARN_EVERY = 6;
const TABLE = "bot_contact_memory";

const cache = new Map<string, ContactMemory>();
let tableReady = false;

function key(sessionId: string, contact: string): string {
  return `${sessionId}:${contact}`;
}

function emptyMemory(): ContactMemory {
  return { summary: "", facts: [], recent: [], messageCount: 0, updatedAt: Date.now(), lastLearnedCount: 0 };
}

function memFile(sessionId: string): string {
  const safe = sessionId.replace(/[^\w-]/g, "_");
  return path.join(process.cwd(), "data", "sessions", safe, "memory.json");
}

function readFileStore(sessionId: string): Record<string, ContactMemory> {
  try {
    const file = memFile(sessionId);
    if (!fs.existsSync(file)) return {};
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeFileStore(sessionId: string, store: Record<string, ContactMemory>): void {
  try {
    const file = memFile(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(store, null, 2));
  } catch { /* ignore */ }
}

function sanitize(m: Partial<ContactMemory> | null | undefined): ContactMemory {
  const base = emptyMemory();
  if (!m || typeof m !== "object") return base;
  return {
    summary: typeof m.summary === "string" ? m.summary : "",
    facts: Array.isArray(m.facts) ? m.facts.filter((f): f is string => typeof f === "string").slice(0, MAX_FACTS) : [],
    recent: Array.isArray(m.recent) ? m.recent.filter(t => t && typeof t.text === "string").slice(-MAX_RECENT) : [],
    messageCount: Number.isFinite(m.messageCount) ? Number(m.messageCount) : 0,
    updatedAt: Number.isFinite(m.updatedAt) ? Number(m.updatedAt) : Date.now(),
    lastLearnedCount: Number.isFinite(m.lastLearnedCount) ? Number(m.lastLearnedCount) : 0,
  };
}

async function ensureTable(): Promise<boolean> {
  if (tableReady) return true;
  const r = await dbQuery(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       session_id text NOT NULL,
       contact text NOT NULL,
       data jsonb NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (session_id, contact)
     )`
  );
  tableReady = !!r;
  return tableReady;
}

export async function getMemory(sessionId: string, contact: string): Promise<ContactMemory> {
  const k = key(sessionId, contact);
  const cached = cache.get(k);
  if (cached) return cached;

  let mem: ContactMemory | null = null;
  if (await ensureTable()) {
    const r = await dbQuery(`SELECT data FROM ${TABLE} WHERE session_id = $1 AND contact = $2`, [sessionId, contact]);
    if (r?.rows?.[0]?.data) mem = sanitize(r.rows[0].data as ContactMemory);
  }
  if (!mem) mem = sanitize(readFileStore(sessionId)[contact]);

  cache.set(k, mem);
  return mem;
}

export async function saveMemory(sessionId: string, contact: string, mem: ContactMemory): Promise<void> {
  mem.updatedAt = Date.now();
  cache.set(key(sessionId, contact), mem);

  const store = readFileStore(sessionId);
  store[contact] = mem;
  writeFileStore(sessionId, store);

  if (await ensureTable()) {
    await dbQuery(
      `INSERT INTO ${TABLE} (session_id, contact, data, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (session_id, contact) DO UPDATE SET data = $3::jsonb, updated_at = now()`,
      [sessionId, contact, JSON.stringify(mem)]
    );
  }
}

export async function deleteMemory(sessionId: string, contact: string): Promise<void> {
  cache.delete(key(sessionId, contact));
  const store = readFileStore(sessionId);
  delete store[contact];
  writeFileStore(sessionId, store);
  if (await ensureTable()) {
    await dbQuery(`DELETE FROM ${TABLE} WHERE session_id = $1 AND contact = $2`, [sessionId, contact]);
  }
}

export async function listMemories(sessionId: string): Promise<(ContactMemory & { contact: string })[]> {
  const merged = new Map<string, ContactMemory>();
  for (const [contact, mem] of Object.entries(readFileStore(sessionId))) merged.set(contact, sanitize(mem));

  if (await ensureTable()) {
    const r = await dbQuery(`SELECT contact, data FROM ${TABLE} WHERE session_id = $1`, [sessionId]);
    for (const row of (r?.rows ?? []) as { contact: string; data: ContactMemory }[]) {
      merged.set(row.contact, sanitize(row.data));
    }
  }
  return [...merged.entries()]
    .filter(([, m]) => m.facts.length || m.summary || m.messageCount)
    .map(([contact, m]) => ({ contact, ...m }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Record one exchange for this contact (memory is trimmed to the last N turns). */
export async function appendTurn(
  sessionId: string,
  contact: string,
  role: "user" | "assistant",
  text: string
): Promise<ContactMemory> {
  const mem = await getMemory(sessionId, contact);
  if (!text.trim()) return mem;
  mem.recent.push({ role, text: text.slice(0, 400), at: Date.now() });
  if (mem.recent.length > MAX_RECENT) mem.recent = mem.recent.slice(-MAX_RECENT);
  if (role === "user") mem.messageCount += 1;
  await saveMemory(sessionId, contact, mem);
  return mem;
}

export async function setFacts(sessionId: string, contact: string, facts: string[], summary?: string): Promise<ContactMemory> {
  const mem = await getMemory(sessionId, contact);
  mem.facts = facts.map(f => String(f).trim()).filter(Boolean).slice(0, MAX_FACTS);
  if (typeof summary === "string") mem.summary = summary.trim();
  await saveMemory(sessionId, contact, mem);
  return mem;
}

/** Prompt snippet telling the model who it is talking to. */
export function memoryPromptBlock(mem: ContactMemory, displayName?: string): string {
  const lines: string[] = [];
  if (displayName) lines.push(`You are talking to ${displayName}.`);
  if (mem.summary) lines.push(`What you know about them: ${mem.summary}`);
  if (mem.facts.length) lines.push(`Remembered facts:\n- ${mem.facts.join("\n- ")}`);
  if (!lines.length) return "";
  return `\n\n[Contact memory — use it naturally, don't recite it]\n${lines.join("\n")}`;
}

/**
 * Every few messages, summarise the recent exchange into durable facts using the
 * provider pool. Fire-and-forget: failures never affect the chat reply.
 */
export async function learnIfNeeded(
  sessionId: string,
  contact: string,
  displayName: string | undefined,
  settings: BotSettings
): Promise<void> {
  if (!settings.features?.memory) return;
  const mem = await getMemory(sessionId, contact);
  if (mem.messageCount < LEARN_EVERY) return;
  if (mem.messageCount - mem.lastLearnedCount < LEARN_EVERY) return;
  if (!mem.recent.length) return;
  if (!(settings.aiProviders ?? []).length) return;

  const transcript = mem.recent
    .slice(-20)
    .map(t => `${t.role === "user" ? displayName || "Them" : "Me"}: ${t.text}`)
    .join("\n");
  const existing = mem.facts.length ? mem.facts.join("\n") : "(none yet)";

  const prompt =
    `You keep private notes about a WhatsApp contact${displayName ? ` named ${displayName}` : ""}. ` +
    `From the transcript, extract stable, useful facts (who they are, names, preferences, plans, important dates, tone). ` +
    `Do not invent anything. Merge with existing notes and drop duplicates or trivial small talk.\n\n` +
    `Existing facts:\n${existing}\n\nTranscript:\n${transcript}\n\n` +
    `Respond with strict JSON only: {"summary":"one sentence about them","facts":["fact 1","fact 2"]}`;

  try {
    const { text } = await callAiWithPool(settings, prompt, "You extract memories. Output strict JSON only.", [], {
      maxTokens: 400,
      plain: true,
    });
    const parsed = parseMemoryJson(text);
    if (!parsed) return;
    const facts = [...new Set([...mem.facts, ...parsed.facts])].slice(-MAX_FACTS);
    const updated = await getMemory(sessionId, contact);
    updated.facts = facts;
    if (parsed.summary) updated.summary = parsed.summary.slice(0, 300);
    updated.lastLearnedCount = updated.messageCount;
    await saveMemory(sessionId, contact, updated);
  } catch {
    /* best-effort */
  }
}

function parseMemoryJson(raw: string): { summary?: string; facts: string[] } | null {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as { summary?: string; facts?: unknown };
    const facts = Array.isArray(obj.facts)
      ? obj.facts.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
      : [];
    if (!facts.length && !obj.summary) return null;
    return { summary: typeof obj.summary === "string" ? obj.summary : undefined, facts };
  } catch {
    return null;
  }
}
