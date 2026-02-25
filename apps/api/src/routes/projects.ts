import { randomUUID } from "node:crypto";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Router } from "express";
import { query } from "../db/client.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function projectsRouter(): Router {
  const router = Router();

  router.post("/projects", async (req, res) => {
    const body = req.body as { name?: string; localPath?: string };

    if (!body.name || !body.localPath) {
      return res.status(400).json({ error: "name and localPath are required" });
    }

    if (!isAbsolute(body.localPath)) {
      return res.status(400).json({ error: "localPath must be an absolute path" });
    }

    if (!(await pathExists(body.localPath))) {
      return res.status(400).json({ error: "localPath does not exist" });
    }

    const fileStat = await stat(body.localPath);
    if (!fileStat.isDirectory()) {
      return res.status(400).json({ error: "localPath must be a directory" });
    }

    const id = randomUUID();

    await query(
      `insert into projects (id, name, local_path)
       values ($1, $2, $3)`,
      [id, body.name, body.localPath]
    );

    return res.status(201).json({
      id,
      name: body.name,
      localPath: body.localPath,
      createdAt: new Date().toISOString()
    });
  });

  return router;
}
