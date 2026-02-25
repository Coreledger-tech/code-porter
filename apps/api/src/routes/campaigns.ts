import { randomUUID } from "node:crypto";
import { Router } from "express";
import { query } from "../db/client.js";
import { executeCampaignRun } from "../workflow-service.js";

interface IdRow {
  id: string;
}

export function campaignsRouter(): Router {
  const router = Router();

  router.post("/campaigns", async (req, res) => {
    const body = req.body as {
      projectId?: string;
      policyId?: string;
      recipePack?: string;
      targetSelector?: string;
    };

    if (!body.projectId || !body.policyId || !body.recipePack) {
      return res.status(400).json({
        error: "projectId, policyId, and recipePack are required"
      });
    }

    const projectCheck = await query<IdRow>(
      `select id from projects where id = $1`,
      [body.projectId]
    );
    if (projectCheck.rows.length === 0) {
      return res.status(404).json({ error: "project not found" });
    }

    const policyCheck = await query<IdRow>(
      `select id from policies where id = $1`,
      [body.policyId]
    );
    if (policyCheck.rows.length === 0) {
      return res.status(404).json({ error: "policy not found" });
    }

    const id = randomUUID();
    await query(
      `insert into campaigns (id, project_id, policy_id, recipe_pack, target_selector)
       values ($1, $2, $3, $4, $5)`,
      [id, body.projectId, body.policyId, body.recipePack, body.targetSelector ?? null]
    );

    return res.status(201).json({
      id,
      projectId: body.projectId,
      policyId: body.policyId,
      recipePack: body.recipePack,
      targetSelector: body.targetSelector,
      createdAt: new Date().toISOString()
    });
  });

  router.post("/campaigns/:id/plan", async (req, res) => {
    const campaignId = req.params.id;
    const result = await executeCampaignRun(campaignId, "plan");
    return res.status(202).json(result);
  });

  router.post("/campaigns/:id/apply", async (req, res) => {
    const campaignId = req.params.id;
    const result = await executeCampaignRun(campaignId, "apply");
    return res.status(202).json(result);
  });

  return router;
}
