import fs from "fs";
import path from "path";

export interface ChatToggles {
    vv: boolean;
    anticall: boolean;
    autoreply: boolean;
}

const FILE = path.join(process.cwd(), "data", "chat-settings.json");

let cache: Record<string, Partial<ChatToggles>> | null = null;

function load(): Record<string, Partial<ChatToggles>> {
    try {
        if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, "utf8"));
    } catch { /* ignore corrupt file */ }
    return {};
}

export function getChatToggles(jid: string): ChatToggles {
    if (!cache) cache = load();
    // View-once auto-save is personal-chat only by design.
    const base: ChatToggles = jid.endsWith("@g.us")
        ? { vv: false, anticall: false, autoreply: true }
        : { vv: true, anticall: false, autoreply: true };
    return { ...base, ...(cache[jid] ?? {}) };
}

export function setChatToggle(jid: string, key: keyof ChatToggles, value: boolean): ChatToggles {
    if (!cache) cache = load();
    cache[jid] = { ...(cache[jid] ?? {}), [key]: value };
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
    } catch { /* ignore write errors */ }
    return getChatToggles(jid);
}
