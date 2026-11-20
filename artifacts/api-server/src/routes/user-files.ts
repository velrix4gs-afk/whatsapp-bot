import { Router } from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const router = Router();
let supabase: any = null;
try {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
        supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { realtime: { transport: ws as any } });
    }
} catch (e) {
    console.error("user-files: Supabase init failed:", e);
}

function fileType(name: string, mime?: string): "image" | "video" | "audio" | "file" {
    const m = String(mime || "").toLowerCase();
    if (m.startsWith("image/")) return "image";
    if (m.startsWith("video/")) return "video";
    if (m.startsWith("audio/")) return "audio";
    const ext = name.split(".").pop()?.toLowerCase() || "";
    if (["jpg", "jpeg", "png", "gif", "webp", "heic", "bmp", "avif"].includes(ext)) return "image";
    if (["mp4", "mov", "webm", "mkv", "3gp", "avi"].includes(ext)) return "video";
    if (["mp3", "ogg", "opus", "m4a", "wav", "aac"].includes(ext)) return "audio";
    return "file";
}

router.post("/user/files", async (req, res) => {
    try {
        if (!supabase) { res.status(503).json({ ok: false, error: "Storage not configured" }); return; }
        const { phone, pin } = req.body;
        const cleanPhone = phone.replace(/\D/g, "");

        // 🔑 EXACT SAME HASH AS TELEGRAM BOT
        const pinHash = crypto.createHash("sha256").update(`${cleanPhone}:${pin}:wabot`).digest("hex");

        const { data: user } = await supabase.from("users").select("phone").eq("phone", cleanPhone).eq("pin_hash", pinHash).maybeSingle();
        if (!user) { res.status(401).json({ ok: false, error: "Invalid phone or PIN" }); return; }

        const { data: files } = await supabase.storage.from("saved_media").list(cleanPhone, { limit: 100, sortBy: { column: "created_at", order: "desc" } });

        const urls = ((files || []) as any[]).map((f: any) => {
            const { data } = supabase.storage.from("saved_media").getPublicUrl(`${cleanPhone}/${f.name}`);
            return {
                name: f.name,
                url: data.publicUrl,
                created_at: f.created_at,
                size: f.metadata?.size,
                type: fileType(f.name, f.metadata?.mimetype),
            };
        });

        res.json({ ok: true, files: urls });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.post("/user/files/delete", async (req, res) => {
    try {
        if (!supabase) { res.status(503).json({ ok: false, error: "Storage not configured" }); return; }
        const { phone, pin, name } = req.body || {};
        const cleanPhone = String(phone ?? "").replace(/\D/g, "");
        const fileName = String(name ?? "");
        if (!cleanPhone || !pin) { res.status(400).json({ ok: false, error: "Phone and PIN required" }); return; }
        if (!fileName || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
            res.status(400).json({ ok: false, error: "Invalid file name" });
            return;
        }

        const pinHash = crypto.createHash("sha256").update(`${cleanPhone}:${pin}:wabot`).digest("hex");
        const { data: user } = await supabase.from("users").select("phone").eq("phone", cleanPhone).eq("pin_hash", pinHash).maybeSingle();
        if (!user) { res.status(401).json({ ok: false, error: "Invalid phone or PIN" }); return; }

        const { error } = await supabase.storage.from("saved_media").remove([`${cleanPhone}/${fileName}`]);
        if (error) { res.status(500).json({ ok: false, error: error.message }); return; }
        res.json({ ok: true });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

export default router;