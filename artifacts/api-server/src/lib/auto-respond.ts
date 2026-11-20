import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface AutoRule {
    id: string;
    /** Phone digits (or full jid) of the contact this rule applies to. */
    contact: string;
    triggers: string[];
    /** Sent verbatim when `instructions` is empty. Supports {name}. */
    reply: string;
    /** When set, the AI generates the reply using these instructions. */
    instructions?: string;
    enabled: boolean;
    createdAt: number;
}

const FILE = path.join(process.cwd(), "data", "auto-respond.json");

function load(): AutoRule[] {
    try {
        if (fs.existsSync(FILE)) {
            const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
            if (Array.isArray(parsed)) return parsed as AutoRule[];
        }
    } catch { /* ignore corrupt file */ }
    return [];
}

function save(rules: AutoRule[]): void {
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(rules, null, 2));
    } catch { /* ignore write errors */ }
}

export function listAutoRules(): AutoRule[] {
    return load();
}

export function upsertAutoRule(input: Partial<AutoRule>): AutoRule | null {
    const contact = String(input.contact ?? "").replace(/\D/g, "");
    const triggers = Array.isArray(input.triggers)
        ? input.triggers.map(t => String(t ?? "").trim()).filter(Boolean)
        : [];
    const reply = String(input.reply ?? "").trim();
    const instructions = input.instructions ? String(input.instructions).trim() : "";
    if (!contact || triggers.length === 0 || (!reply && !instructions)) return null;

    const rules = load();
    const id = input.id || "auto_" + crypto.randomBytes(6).toString("hex");
    const rule: AutoRule = {
        id,
        contact,
        triggers,
        reply,
        instructions: instructions || undefined,
        enabled: input.enabled !== false,
        createdAt: input.id ? (rules.find(r => r.id === id)?.createdAt ?? Date.now()) : Date.now(),
    };
    const idx = rules.findIndex(r => r.id === id);
    if (idx >= 0) rules[idx] = rule; else rules.push(rule);
    save(rules);
    return rule;
}

export function deleteAutoRule(id: string): boolean {
    const rules = load();
    const next = rules.filter(r => r.id !== id);
    if (next.length === rules.length) return false;
    save(next);
    return true;
}

/** First enabled rule for this sender whose trigger matches the text (case-insensitive contains). */
export function matchAutoRule(rules: AutoRule[], contactDigits: string, text: string): AutoRule | null {
    const t = text.trim().toLowerCase();
    if (!t) return null;
    for (const rule of rules) {
        if (!rule.enabled) continue;
        if (rule.contact !== contactDigits) continue;
        if (rule.triggers.some(tr => t.includes(tr.toLowerCase()))) return rule;
    }
    return null;
}
