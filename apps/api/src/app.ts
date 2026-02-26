import express from "express";
import { buildHealthResponse } from "./health.js";
import { metrics } from "./observability/metrics.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { projectsRouter } from "./routes/projects.js";
import { reportsRouter } from "./routes/reports.js";
import { runsRouter } from "./routes/runs.js";

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/health", async (req, res, next) => {
    try {
      const probeNetwork = req.query.probe === "network";
      const health = await buildHealthResponse({ probeNetwork });
      res.json(health);
    } catch (error) {
      next(error);
    }
  });

  app.get("/metrics", async (_req, res, next) => {
    try {
      const payload = await metrics.render();
      res.setHeader("Content-Type", metrics.contentType());
      res.send(payload);
    } catch (error) {
      next(error);
    }
  });

  app.use(projectsRouter());
  app.use(campaignsRouter());
  app.use(runsRouter());
  app.use(reportsRouter());

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
