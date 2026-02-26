# Code Porter

Deterministic-first modernization control plane for upgrade campaigns with policy gates, verifier checks, async workers, and auditable evidence bundles.

## Pilot Start (V1 Beta)

```bash
docker compose up --build
```

API default:
- `http://localhost:3000`

## Async Runtime (Host Process)

```bash
npm run db:up
npm run db:migrate
npm run api:start
npm run worker:start
```

Run start endpoints (`/campaigns/:id/plan`, `/campaigns/:id/apply`) now enqueue and return `status: queued`.
Track progress with:
- `GET /runs/:id`
- `GET /runs/:id/events`
- `POST /runs/:id/cancel`
- `POST /campaigns/:id/pause`
- `POST /campaigns/:id/resume`
- `GET /projects/:id/summary`
- `GET /campaigns/:id/summary`

Prometheus metrics:
- `GET /metrics`

## Quick API Flow (GitHub Project)

```bash
# 1) Register GitHub project
PROJECT_ID=$(curl -s -X POST http://localhost:3000/projects/github \
  -H "Content-Type: application/json" \
  -d '{
    "name":"code-porter",
    "owner":"Coreledger-tech",
    "repo":"code-porter"
  }' | jq -r '.id')

# 2) Create campaign
CAMPAIGN_ID=$(curl -s -X POST http://localhost:3000/campaigns \
  -H "Content-Type: application/json" \
  -d "{
    \"projectId\":\"$PROJECT_ID\",
    \"policyId\":\"default\",
    \"recipePack\":\"java-maven-core\",
    \"targetSelector\":\"main\"
  }" | jq -r '.id')

# 3) Apply
RUN_ID=$(curl -s -X POST http://localhost:3000/campaigns/$CAMPAIGN_ID/apply | jq -r '.runId')

# 4) Inspect run
curl -s http://localhost:3000/runs/$RUN_ID | jq
```

Run response includes:
- `prUrl` when GitHub PR creation succeeds
- `evidenceZipUrl` and `evidenceManifestUrl`
- `evidenceStorage` and `evidenceUrlMode`

## Test Commands

```bash
npm test
npm run test:integration
```

## Cleanup Commands

```bash
npm run cleanup:workspaces
npm run cleanup:evidence
```
