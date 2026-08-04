import "express-async-errors";
import express from "express";
import path from "path";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { authRouter } from "./routes/auth";
import { libraryRouter } from "./routes/library";
import { scenesRouter } from "./routes/scenes";

export function createApp() {
  const app = express();

  if (process.env.NODE_ENV !== "production") {
    app.use(cors({ origin: true, credentials: true }));
  }
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());
  app.use("/storage", express.static(path.join(__dirname, "..", "storage")));

  const v1 = express.Router();
  v1.use(authRouter);
  v1.use(libraryRouter);
  v1.use(scenesRouter);
  app.use("/api/v1", v1);

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: "系統內部錯誤", detail: err instanceof Error ? err.message : String(err) });
  });

  return app;
}
