import express from "express";
import { campaignsRouter } from "./routes/campaigns.js";
import { projectsRouter } from "./routes/projects.js";
import { runsRouter } from "./routes/runs.js";

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(projectsRouter());
  app.use(campaignsRouter());
  app.use(runsRouter());

  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      // eslint-disable-next-line no-console
      console.error(error);
      const message =
        error instanceof Error ? error.message : "Internal server error";
      res.status(500).json({ error: message });
    }
  );

  return app;
}
