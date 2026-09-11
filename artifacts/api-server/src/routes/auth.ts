import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const router: IRouter = Router();

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
        realtime: {
            transport: ws as any,
        },
    }
);

// Hash PIN with a salt (simple, no bcrypt dependency)
function hashPin(pin: string, phone: string): string {
    return crypto.createHash("sha256").update(`${phone}:${pin}:wabot`).digest("hex");
}

// ── Register ──────────────────────────────────────────────────────────
router.post("/auth/register", async (req: Request, res: Response) => {
    try {
        const { phone, pin } = req.body || {};
        if (!phone || !pin) {
            res.status(400).json({ ok: false, error: "Phone and PIN required" });
            return;
        }
        if (!/^\d{4}$/.test(pin)) {
            res.status(400).json({ ok: false, error: "PIN must be 4 digits" });
            return;
        }

        const cleanPhone = phone.replace(/\D/g, "");
        const pinHash = hashPin(pin, cleanPhone);

        // Check if already exists
        const { data: existing } = await supabase
            .from("users")
            .select("phone")
            .eq("phone", cleanPhone)
            .maybeSingle();

        if (existing) {
            res.status(409).json({ ok: false, error: "Phone already registered. Please login." });
            return;
        }

        // Insert user
        const { error: insertError } = await supabase
            .from("users")
            .insert({ phone: cleanPhone, pin_hash: pinHash });

        if (insertError) {
            res.status(500).json({ ok: false, error: insertError.message });
            return;
        }

        // Create default settings
        await supabase
            .from("user_settings")
            .insert({ phone: cleanPhone });

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: (e as Error).message });
    }
});

// ── Login ─────────────────────────────────────────────────────────────
router.post("/auth/login", async (req: Request, res: Response) => {
    try {
        const { phone, pin } = req.body || {};
        if (!phone || !pin) {
            res.status(400).json({ ok: false, error: "Phone and PIN required" });
            return;
        }

        const cleanPhone = phone.replace(/\D/g, "");
        const pinHash = hashPin(pin, cleanPhone);

        const { data: user } = await supabase
            .from("users")
            .select("phone, pin_hash, session_id")
            .eq("phone", cleanPhone)
            .maybeSingle();

        if (!user || user.pin_hash !== pinHash) {
            res.status(401).json({ ok: false, error: "Invalid phone or PIN" });
            return;
        }

        const { data: settings } = await supabase
            .from("user_settings")
            .select("*")
            .eq("phone", cleanPhone)
            .maybeSingle();

        res.json({
            ok: true,
            user: { phone: user.phone, session_id: user.session_id },
            settings: settings || {},
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: (e as Error).message });
    }
});

// ── Get settings ──────────────────────────────────────────────────────
router.post("/auth/settings", async (req: Request, res: Response) => {
    try {
        const { phone, pin } = req.body || {};
        const cleanPhone = (phone || "").replace(/\D/g, "");
        const pinHash = hashPin(pin || "", cleanPhone);

        const { data: user } = await supabase
            .from("users")
            .select("phone")
            .eq("phone", cleanPhone)
            .eq("pin_hash", pinHash)
            .maybeSingle();

        if (!user) {
            res.status(401).json({ ok: false, error: "Unauthorized" });
            return;
        }

        const { data: settings } = await supabase
            .from("user_settings")
            .select("*")
            .eq("phone", cleanPhone)
            .maybeSingle();

        res.json({ ok: true, settings: settings || {} });
    } catch (e) {
        res.status(500).json({ ok: false, error: (e as Error).message });
    }
});

// ── Update settings ───────────────────────────────────────────────────
router.post("/auth/settings/update", async (req: Request, res: Response) => {
    try {
        const { phone, pin, settings } = req.body || {};
        const cleanPhone = (phone || "").replace(/\D/g, "");
        const pinHash = hashPin(pin || "", cleanPhone);

        const { data: user } = await supabase
            .from("users")
            .select("phone")
            .eq("phone", cleanPhone)
            .eq("pin_hash", pinHash)
            .maybeSingle();

        if (!user) {
            res.status(401).json({ ok: false, error: "Unauthorized" });
            return;
        }

        const allowed = ["view_once", "auto_react", "auto_presence", "anti_delete", "ai_chat"];
        const update: Record<string, boolean> = {};
        for (const key of allowed) {
            if (typeof settings?.[key] === "boolean") update[key] = settings[key];
        }

        if (Object.keys(update).length === 0) {
            res.status(400).json({ ok: false, error: "No valid settings" });
            return;
        }

        update["updated_at"] = new Date().toISOString() as any;

        const { error } = await supabase
            .from("user_settings")
            .update(update)
            .eq("phone", cleanPhone);

        if (error) {
            res.status(500).json({ ok: false, error: error.message });
            return;
        }

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: (e as Error).message });
    }
});

// ── Link session to user ──────────────────────────────────────────────
router.post("/auth/link-session", async (req: Request, res: Response) => {
    try {
        const { phone, pin, session_id } = req.body || {};
        const cleanPhone = (phone || "").replace(/\D/g, "");
        const pinHash = hashPin(pin || "", cleanPhone);

        const { data: user } = await supabase
            .from("users")
            .select("phone")
            .eq("phone", cleanPhone)
            .eq("pin_hash", pinHash)
            .maybeSingle();

        if (!user) {
            res.status(401).json({ ok: false, error: "Unauthorized" });
            return;
        }

        const { error } = await supabase
            .from("users")
            .update({ session_id })
            .eq("phone", cleanPhone);

        if (error) {
            res.status(500).json({ ok: false, error: error.message });
            return;
        }

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: (e as Error).message });
    }
});

export default router;