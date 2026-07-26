import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { MulterError } from "multer";
import router from "./routes";
import { logger } from "./lib/logger";
import { configureSessions } from "./lib/auth";

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
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
configureSessions(app);

app.use("/api", router);

// Deterministic JSON errors for middleware failures (multer, body parsing)
// that would otherwise fall through to Express's HTML 500 handler.
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "That file is too large."
        : `Upload failed: ${err.message}`;
    res.status(status).json({ error: message });
    return;
  }
  if ((err as { type?: string })?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Request body is not valid JSON." });
    return;
  }
  logger.error(
    { err: err instanceof Error ? err.message : String(err), url: req.url },
    "Unhandled request error",
  );
  res.status(500).json({ error: "Internal server error" });
});

export default app;
