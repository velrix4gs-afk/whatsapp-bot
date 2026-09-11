import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import router from "./routes";
import { logger } from "./lib/logger";
import sessionsRouter from "./routes/sessions";
import authRouter from "./routes/auth";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
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

app.use("/api", sessionsRouter);
app.use("/api", authRouter);
app.use("/api", router);

app.get("/admin", (_req, res) => {
  const filePath = path.join(process.cwd(), "public", "admin.html");
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send("Dashboard not found. Expected at: " + filePath);
  }
});

app.get("/login", (_req, res) => {
  const filePath = path.join(process.cwd(), "public", "user-login.html");
  if (fs.existsSync(filePath)) res.sendFile(filePath);
  else res.status(404).send("Login page not found");
});

app.get("/user", (_req, res) => {
  const filePath = path.join(process.cwd(), "public", "user.html");
  if (fs.existsSync(filePath)) res.sendFile(filePath);
  else res.status(404).send("User page not found");
});

app.get("/user-settings", (_req, res) => {
  const filePath = path.join(process.cwd(), "public", "user-settings.html");
  if (fs.existsSync(filePath)) res.sendFile(filePath);
  else res.status(404).send("Settings page not found");
});

// Redirect root to admin dashboard
app.get("/", (_req, res) => {
  res.redirect("/admin");
});

export default app;