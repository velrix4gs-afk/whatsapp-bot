import { providerPreset, getProviderPool, type AiProviderConfig, type AiRule, type BotSettings } from "./settings";
import type { AiChatMessage } from "./ai-sessions";

export function matchRule(rule: AiRule, text: string): boolean {
    if (!rule.enabled) return false;
    const t = text.toLowerCase();
    const trig = rule.trigger.toLowerCase();
    try {
        switch (rule.matchType) {
            case "exact": return t === trig;
            case "contains": return t.includes(trig);
            case "startsWith": return t.startsWith(trig);
            case "endsWith": return t.endsWith(trig);
            case "regex": return new RegExp(trig, "i").test(text);
            default: return false;
        }
    } catch {
        return false;
    }
}

export function firstMatchingRule(rules: AiRule[] | undefined, text: string): AiRule | null {
    for (const r of rules ?? []) {
        if (matchRule(r, text)) return r;
    }
    return null;
}

export const DEFAULT_SYSTEM_PROMPT =
    "You are a real person chatting on WhatsApp — warm, casual, a little witty. " +
    "You talk like a friend, not like a customer support agent.";

/** Appended to every chat prompt — WhatsApp messages must stay short and human. */
export const SHORT_REPLY_RULE =
    "\n\nHow you text:\n" +
    "- Reply with 1-2 short sentences, max ~25 words. Never essays, lists or headings.\n" +
    "- Respond to what was actually just said; if a message is quoted, answer that message.\n" +
    "- Never send filler or check-in messages: no \"I'm here to help\", no \"What's on your mind?\", " +
    "no \"How can I assist you today?\", no \"Let me know if you need anything\".\n" +
    "- Don't re-introduce yourself or announce you're an AI/bot. Don't offer menus of things you can do.\n" +
    "- Mirror the other person's tone and language (pidgin, slang, emojis — match what they use).\n" +
    "- If they're joking, joke back lightly. Be useful when they ask something real; " +
    "when they just chat, chat back naturally instead of steering to a task.\n" +
    "- A short natural reaction beats a polished canned line.";

/** Boilerplate assistant filler that must never reach a WhatsApp chat. */
const FILLER_REPLY = new RegExp(
    "^(hi|hello|hey)?[!.,\\s]*" +
    "(i'?m here to (help|assist)|how (can|may) i (help|assist)|what'?s on your mind|" +
    "is there anything (else )?i can (do|help)|let me know if you (need|have)|" +
    "i'?m here for you|feel free to ask|how'?s it going\\?\\s*$)",
    "i"
);

export function isFillerReply(text: string): boolean {
    const t = String(text ?? "").trim();
    if (!t) return true;
    if (t.length > 120) return false;
    return FILLER_REPLY.test(t);
}

const MAX_TOKENS = 220;
const MAX_REPLY_CHARS = 450;

export interface CallOptions {
    /** Providers to try first (persona preference). */
    preferredId?: string;
    maxTokens?: number;
    /** Skip the WhatsApp short-reply styling (used for internal summarising tasks). */
    plain?: boolean;
}

/** Clamp model output so a chatty model can't flood the chat. */
export function trimReply(text: string): string {
    let out = String(text ?? "").trim().replace(/\n{3,}/g, "\n\n");
    if (out.length <= MAX_REPLY_CHARS) return out;
    const cut = out.slice(0, MAX_REPLY_CHARS);
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
    if (lastStop > MAX_REPLY_CHARS * 0.5) out = cut.slice(0, lastStop + 1);
    else out = cut.slice(0, MAX_REPLY_CHARS - 1).trimEnd() + "…";
    return out.trim();
}

export function providerBaseUrl(p: AiProviderConfig): string {
    const preset = providerPreset(p.provider);
    return (p.baseUrl?.trim() || preset?.baseUrl || "").replace(/\/+$/, "");
}

export async function callAiProvider(
    provider: AiProviderConfig,
    text: string,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    history: AiChatMessage[] = [],
    opts: CallOptions = {}
): Promise<string> {
    const prompt = (systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT) + (opts.plain ? "" : SHORT_REPLY_RULE);
    const maxTokens = opts.maxTokens ?? MAX_TOKENS;
    let reply: string;
    switch (provider.provider) {
        case "anthropic": reply = await callAnthropic(provider, text, prompt, history, maxTokens); break;
        case "gemini": reply = await callGemini(provider, text, prompt, history, maxTokens); break;
        case "openai": reply = await callOpenAiCompatible(provider, "https://api.openai.com/v1", text, prompt, history, maxTokens); break;
        case "custom": reply = await callOpenAiCompatible(provider, providerBaseUrl(provider), text, prompt, history, maxTokens); break;
        default: {
            // ai21, cohere, dashscope, modelscope, nvidia, ollama, openrouter, groq, mistral
            const preset = providerPreset(provider.provider);
            if (!preset) throw new Error(`Unsupported AI provider: ${provider.provider}`);
            reply = await callOpenAiCompatible(provider, providerBaseUrl(provider), text, prompt, history, maxTokens);
        }
    }
    return opts.plain ? reply : (trimReply(reply) || "(no response)");
}

/** Sticky provider — the last provider that worked is tried first next time. */
let lastGoodProviderId = "";
let lastGoodAt = 0;
const STICKY_MS = 30 * 60_000;

/**
 * Failover pool: walks the providers in order (preferred → last good → default → rest)
 * and silently rotates to the next one when a provider errors, rate-limits or times out.
 */
export async function callAiWithPool(
    settings: BotSettings,
    text: string,
    systemPrompt: string,
    history: AiChatMessage[] = [],
    opts: CallOptions = {}
): Promise<{ text: string; providerId: string }> {
    const pool = getProviderPool(settings, opts.preferredId);
    if (!pool.length) throw new Error("No AI provider configured. Add one in the admin panel.");

    // Sticky: unless a persona pinned a provider, start with the last working one.
    // After 30 quiet minutes the default provider is tried first again, so a
    // recovered laptop endpoint automatically becomes primary once more.
    if (!opts.preferredId && lastGoodProviderId && Date.now() - lastGoodAt < STICKY_MS) {
        const idx = pool.findIndex(p => p.id === lastGoodProviderId);
        if (idx > 0) pool.unshift(...pool.splice(idx, 1));
    }

    const errors: string[] = [];
    const startedAt = Date.now();
    const TOTAL_BUDGET_MS = 40_000;
    for (const provider of pool) {
        if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
            errors.push("(gave up after 40s to keep the reply fast)");
            break;
        }
        try {
            const reply = await withTimeout(
                callAiProvider(provider, text, systemPrompt, history, { ...opts, plain: opts.plain }),
                15_000
            );
            lastGoodProviderId = provider.id;
            lastGoodAt = Date.now();
            return { text: reply, providerId: provider.id };
        } catch (e) {
            const name = provider.label || provider.provider;
            const msg = e instanceof Error ? e.message : String(e);
            errors.push(`${name}: ${msg}`);
            console.warn(`[ai] provider "${name}" failed — rotating: ${msg}`);
        }
    }
    throw new Error(`All AI providers failed.\n${errors.join("\n")}`);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms)),
    ]);
}

async function readError(res: Response): Promise<string> {
    let detail = "";
    try {
        const body = await res.text();
        if (body) detail = ` - ${body.slice(0, 200)}`;
    } catch { /* ignore */ }
    return `AI request failed (${res.status} ${res.statusText})${detail}`;
}

function authHeaders(p: AiProviderConfig, baseUrl: string): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (p.apiKey) headers["Authorization"] = `Bearer ${p.apiKey}`;
    if (/openrouter\.ai/i.test(baseUrl)) {
        headers["HTTP-Referer"] = "https://novabot.local";
        headers["X-Title"] = "NovaBot";
    }
    return headers;
}

async function callOpenAiCompatible(
    p: AiProviderConfig,
    baseUrl: string,
    text: string,
    systemPrompt: string,
    history: AiChatMessage[],
    maxTokens: number
): Promise<string> {
    if (!baseUrl) throw new Error("This provider needs a Base URL");
    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: authHeaders(p, baseUrl),
        body: JSON.stringify({
            model: p.model,
            messages: [
                { role: "system", content: systemPrompt },
                ...history,
                { role: "user", content: text },
            ],
            max_tokens: maxTokens,
            temperature: 0.8,
        }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() || "(no response)";
}

async function callAnthropic(
    p: AiProviderConfig,
    text: string,
    systemPrompt: string,
    history: AiChatMessage[],
    maxTokens: number
): Promise<string> {
    const res = await fetch(`${providerBaseUrl(p) || "https://api.anthropic.com/v1"}/messages`, {
        method: "POST",
        headers: {
            "x-api-key": p.apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: p.model || "claude-3-5-haiku-20241022",
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: [...history, { role: "user", content: text }],
        }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as { content?: { type: string; text: string }[] };
    return data.content?.map(c => c.text).join("").trim() || "(no response)";
}

/** Gemini rejects "models/…" prefixes, spaces and mixed case — normalize what users type. */
function normalizeGeminiModel(raw?: string): string {
    const m = String(raw ?? "").trim().toLowerCase()
        .replace(/^models\//, "")
        .replace(/\s+/g, "-");
    return /^[a-z0-9._-]+$/.test(m) && m ? m : "gemini-2.5-flash";
}

async function callGemini(
    p: AiProviderConfig,
    text: string,
    systemPrompt: string,
    history: AiChatMessage[],
    maxTokens: number
): Promise<string> {
    const baseUrl = providerBaseUrl(p) || "https://generativelanguage.googleapis.com/v1beta";
    const model = normalizeGeminiModel(p.model);
    const res = await fetch(`${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(p.apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [
                ...history.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
                { role: "user", parts: [{ text }] },
            ],
            generationConfig: { maxOutputTokens: maxTokens },
        }),
    });
    if (!res.ok) {
        const detail = await readError(res);
        throw new Error(res.status === 404
            ? `${detail} — model "${model}" not found. Try "gemini-2.5-flash".`
            : detail);
    }
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "(no response)";
}
