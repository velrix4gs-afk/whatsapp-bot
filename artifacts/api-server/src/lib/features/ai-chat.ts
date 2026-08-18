import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import type { BotSettings } from "../settings";
import { GoogleGenAI } from "@google/genai";

// Per-session per-chat AI enabled state
const aiEnabledChats = new Map<string, Set<string>>();

// Conversation history per chat (last 20 turns)
const chatHistory = new Map<string, { role: "user" | "model"; parts: { text: string }[] }[]>();

export function isAiEnabled(sessionId: string, chatJid: string): boolean {
  return aiEnabledChats.get(sessionId)?.has(chatJid) ?? false;
}

export function toggleAiChat(sessionId: string, chatJid: string): boolean {
  if (!aiEnabledChats.has(sessionId)) aiEnabledChats.set(sessionId, new Set());
  const set = aiEnabledChats.get(sessionId)!;
  if (set.has(chatJid)) {
    set.delete(chatJid);
    chatHistory.delete(`${sessionId}:${chatJid}`);
    return false;
  }
  set.add(chatJid);
  return true;
}

function getClient(): GoogleGenAI {
  const apiKey = process.env["AI_INTEGRATIONS_GEMINI_API_KEY"];
  const baseUrl = process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"];
  if (!apiKey || !baseUrl) throw new Error("Gemini env vars not configured. Check AI_INTEGRATIONS_GEMINI_BASE_URL and API_KEY.");
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion: "",
      baseUrl,
    },
  });
}

async function geminiChat(
  userMessage: string,
  history: { role: "user" | "model"; parts: { text: string }[] }[],
  systemPrompt: string
): Promise<string> {
  const ai = getClient();

  const contents = [
    ...history,
    { role: "user" as const, parts: [{ text: userMessage }] },
  ];

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents,
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: 8192,
    },
  });

  return response.text ?? "(no response)";
}

export async function handleAiReply(
  sock: WASocket,
  msg: WAMessage,
  sender: string,
  sessionId: string,
  settings: BotSettings,
  addLog: (s: string) => void
): Promise<void> {
  const text =
    msg.message?.conversation ??
    msg.message?.extendedTextMessage?.text ?? "";

  if (!text.trim()) return;

  const historyKey = `${sessionId}:${sender}`;
  const history = chatHistory.get(historyKey) ?? [];

  try {
    addLog(`AI thinking for ${sender}…`);
    const reply = await geminiChat(
      text,
      history.slice(-18),
      settings.aiSystemPrompt || "You are a helpful WhatsApp assistant. Keep responses concise and friendly."
    );

    history.push({ role: "user",  parts: [{ text }] });
    history.push({ role: "model", parts: [{ text: reply }] });
    if (history.length > 20) history.splice(0, history.length - 20);
    chatHistory.set(historyKey, history);

    await sock.sendMessage(sender, { text: reply }, { quoted: msg });
    addLog(`AI replied to ${sender}`);
  } catch (err) {
    const errMsg = (err as Error).message;
    addLog(`AI error: ${errMsg}`);
    await sock.sendMessage(sender, { text: `❌ AI error: ${errMsg.slice(0, 200)}` });
  }
}
