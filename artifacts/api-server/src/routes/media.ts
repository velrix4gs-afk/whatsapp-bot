import { Router, type Request, type Response, type NextFunction } from "express";
import { objectStorageClient } from "../lib/objectStorage";
import { getSession } from "../lib/settings";

const router = Router();
const BUCKET_ID  = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"] ?? "";
const VO_PREFIX  = "view-once";

function requireSession(req: Request, res: Response, next: NextFunction): void {
  const auth    = req.headers["authorization"] ?? "";
  const token   = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const session = token ? getSession(token) : null;
  if (!session) { res.status(401).json({ error: "Unauthorized" }); return; }
  next();
}

// ── GET /api/media  — list all saved view-once files ─────────────────────────
router.get("/media", requireSession, async (_req: Request, res: Response) => {
  if (!BUCKET_ID) { res.status(503).json({ error: "Storage not configured" }); return; }
  try {
    const bucket = objectStorageClient.bucket(BUCKET_ID);
    const [files] = await bucket.getFiles({ prefix: `${VO_PREFIX}/` });
    const items = await Promise.all(
      files
        .filter(f => f.name !== `${VO_PREFIX}/`) // skip the "folder" placeholder
        .map(async (f) => {
          const [meta] = await f.getMetadata();
          return {
            name:        f.name.replace(`${VO_PREFIX}/`, ""),
            objectName:  f.name,
            size:        Number(meta.size ?? 0),
            contentType: String(meta.contentType ?? "application/octet-stream"),
            createdAt:   meta.timeCreated ?? null,
          };
        })
    );
    // newest first
    items.sort((a, b) => (b.createdAt ?? "") > (a.createdAt ?? "") ? 1 : -1);
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/media/download?file=<objectName>  — stream a file ───────────────
router.get("/media/download", requireSession, async (req: Request, res: Response) => {
  if (!BUCKET_ID) { res.status(503).json({ error: "Storage not configured" }); return; }
  const objectName = String(req.query["file"] ?? "");
  if (!objectName || !objectName.startsWith(`${VO_PREFIX}/`)) {
    res.status(400).json({ error: "Invalid file path" });
    return;
  }
  try {
    const bucket = objectStorageClient.bucket(BUCKET_ID);
    const file   = bucket.file(objectName);
    const [exists] = await file.exists();
    if (!exists) { res.status(404).json({ error: "File not found" }); return; }
    const [meta] = await file.getMetadata();
    const filename = objectName.split("/").pop() ?? "file";
    res.setHeader("Content-Type", String(meta.contentType ?? "application/octet-stream"));
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    if (meta.size) res.setHeader("Content-Length", String(meta.size));
    file.createReadStream().pipe(res);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── DELETE /api/media?file=<objectName>  — delete a file ─────────────────────
router.delete("/media", requireSession, async (req: Request, res: Response) => {
  if (!BUCKET_ID) { res.status(503).json({ error: "Storage not configured" }); return; }
  const objectName = String(req.query["file"] ?? "");
  if (!objectName || !objectName.startsWith(`${VO_PREFIX}/`)) {
    res.status(400).json({ error: "Invalid file path" });
    return;
  }
  try {
    const bucket = objectStorageClient.bucket(BUCKET_ID);
    const file   = bucket.file(objectName);
    const [exists] = await file.exists();
    if (!exists) { res.status(404).json({ error: "File not found" }); return; }
    await file.delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
