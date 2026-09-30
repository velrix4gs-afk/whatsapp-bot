import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const router: IRouter = Router();

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    { realtime: { transport: ws as any } }
);

function hashPin(pin: string, phone: string): string {
    return crypto.createHash("sha256").update(`${phone}:${pin}:wabot`).digest("hex");
}

// List files for a user (phone + pin auth)
router.post("/user/files", async (req: Request, res: Response) => {
    try {
        const { phone, pin } = req.body || {};
        if (!phone || !pin) {
            res.status(400).json({ ok: false, error: "Missing phone or pin" });
            return;
        }

        const cleanPhone = phone.replace(/\D/g, "");
        const pinHash = hashPin(pin, cleanPhone);

        // Verify credentials
        const { data: user } = await supabase
            .from("users")
            .select("phone")
            .eq("phone", cleanPhone)
            .eq("pin_hash", pinHash)
            .maybeSingle();

        if (!user) {
            res.status(401).json({ ok: false, error: "Invalid phone or PIN" });
            return;
        }

        // List all files in saved_media/{phone}/
        const { data: files, error } = await supabase
            .storage
            .from("saved_media")
            .list(cleanPhone, {
                limit: 500,
                sortBy: { column: "created_at", order: "desc" },
            });

        if (error) {
            res.status(500).json({ ok: false, error: error.message });
            return;
        }

        const filesWithUrls = (files || [])
            .filter((f) => f.name && !f.name.endsWith("/"))
            .map((f) => {
                const path = `${cleanPhone}/${f.name}`;
                const { data } = supabase.storage.from("saved_media").getPublicUrl(path);

                // Determine type from extension
                const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
                let type = "file";
                if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) type = "image";
                else if (["mp4", "mov", "webm"].includes(ext)) type = "video";
                else if (["ogg", "opus", "mp3"].includes(ext)) type = "audio";

                return {
                    name: f.name,
                    size: (f.metadata as any)?.size ?? 0,
                    created_at: f.created_at ?? f.updated_at ?? null,
                    url: data?.publicUrl ?? "",
                    type,
                };
            });

        res.json({ ok: true, files: filesWithUrls });
    } catch (e) {
        res.status(500).json({ ok: false, error: (e as Error).message });
    }
});

export default router;