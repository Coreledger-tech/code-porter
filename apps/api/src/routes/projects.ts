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
      `insert into projects (id, name, type, local_path, owner, repo, clone_url, default_branch)
       values ($1, $2, 'local', $3, null, null, null, null)`,
      [id, body.name, body.localPath]
    );

    return res.status(201).json({
      id,
      name: body.name,
      type: "local",
      localPath: body.localPath,
      createdAt: new Date().toISOString()
    });
  });

  router.post("/projects/github", async (req, res) => {
    const body = req.body as {
      name?: string;
      owner?: string;
      repo?: string;
      cloneUrl?: string;
      defaultBranch?: string;
    };

    if (!body.name || !body.owner || !body.repo) {
      return res.status(400).json({
        error: "name, owner, and repo are required"
      });
    }

    const id = randomUUID();

    await query(
      `insert into projects (id, name, type, local_path, owner, repo, clone_url, default_branch)
       values ($1, $2, 'github', null, $3, $4, $5, $6)`,
      [
        id,
        body.name,
        body.owner,
        body.repo,
        body.cloneUrl ?? null,
        body.defaultBranch ?? null
      ]
    );

    return res.status(201).json({
      id,
      name: body.name,
      type: "github",
      owner: body.owner,
      repo: body.repo,
      cloneUrl: body.cloneUrl,
      defaultBranch: body.defaultBranch,
      createdAt: new Date().toISOString()
    });
  });

  return router;
}
