import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import router from "./routes";
import { logger } from "./lib/logger";
import sessionsRouter from "./routes/sessions";
import authRouter from "./routes/auth";
import userFilesRouter from "./routes/user-files";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── API routes ────────────────────────────────────────────────────────
app.use("/api", sessionsRouter);
app.use("/api", authRouter);
app.use("/api", userFilesRouter);
app.use("/api", router);

// ── Static HTML pages ─────────────────────────────────────────────────
function sendHtml(file: string, res: any) {
  const filePath = path.join(process.cwd(), "public", file);
  if (fs.existsSync(filePath)) res.sendFile(filePath);
  else res.status(404).send(`Page not found: ${file}`);
}

app.get("/", (_req, res) => sendHtml("admin.html", res));
app.get("/admin", (_req, res) => sendHtml("admin.html", res));
app.get("/login", (_req, res) => sendHtml("user-login.html", res));
app.get("/user-login", (_req, res) => sendHtml("user-login.html", res));
app.get("/user", (_req, res) => sendHtml("user.html", res));
app.get("/user-settings", (_req, res) => sendHtml("user-settings.html", res));
app.get("/my-files", (_req, res) => sendHtml("my-files.html", res));

export default app;