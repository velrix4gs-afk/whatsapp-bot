import type { AiProviderConfig, AiRule } from "./settings";

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

const DEFAULT_SYSTEM_PROMPT =
    "You are a helpful WhatsApp assistant. Keep responses short and friendly.";

export async function callAiProvider(
    provider: AiProviderConfig,
    text: string,
    systemPrompt = DEFAULT_SYSTEM_PROMPT
): Promise<string> {
    const prompt = systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
    switch (provider.provider) {
        case "openai": return callOpenAI(provider, text, prompt);
        case "anthropic": return callAnthropic(provider, text, prompt);
        case "gemini": return callGemini(provider, text, prompt);
        case "custom": return callCustom(provider, text, prompt);
        default: throw new Error(`Unsupported AI provider: ${provider.provider}`);
    }
}

async function readError(res: Response): Promise<string> {
    let detail = "";
    try {
        const body = await res.text();
        if (body) detail = ` - ${body.slice(0, 200)}`;
    } catch { /* ignore */ }
    return `AI request failed (${res.status} ${res.statusText})${detail}`;
}

async function callOpenAI(p: AiProviderConfig, text: string, systemPrompt: string): Promise<string> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            model: p.model || "gpt-4o-mini",
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }],
            max_tokens: 500,
        }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() || "(no response)";
}

async function callAnthropic(p: AiProviderConfig, text: string, systemPrompt: string): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "x-api-key": p.apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: p.model || "claude-3-5-haiku-20241022",
            max_tokens: 500,
            system: systemPrompt,
            messages: [{ role: "user", content: text }],
        }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as { content?: { type: string; text: string }[] };
    return data.content?.map(c => c.text).join("").trim() || "(no response)";
}

async function callGemini(p: AiProviderConfig, text: string, systemPrompt: string): Promise<string> {
    const baseUrl = (p.baseUrl?.replace(/\/$/, "")) || "https://generativelanguage.googleapis.com/v1beta";
    const model = p.model || "gemini-2.5-flash";
    const res = await fetch(`${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(p.apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: [{ text }] }],
            generationConfig: { maxOutputTokens: 500 },
        }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "(no response)";
}

async function callCustom(p: AiProviderConfig, text: string, systemPrompt: string): Promise<string> {
    if (!p.baseUrl) throw new Error("Custom provider needs a Base URL");
    const res = await fetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            model: p.model,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }],
            max_tokens: 500,
        }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() || "(no response)";
}
