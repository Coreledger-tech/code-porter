# Code Porter Security

## Credential Handling

### General Rules
- Credentials are provided via environment variables or mounted files.
- Credentials are never persisted to database rows.
- Credentials are never written to evidence artifacts.

### GitHub App (Preferred)
- Private key loaded from `GITHUB_APP_PRIVATE_KEY_PATH`.
- Installation tokens are short-lived and generated at runtime.
- Tokens cached only in memory and refreshed before expiry.

### PAT (Legacy)
- `GITHUB_TOKEN` remains available for local development.
- PAT mode should be disabled in hosted pilot environments.

## Rotation and Revocation
- GitHub App key rotation:
1. rotate key in GitHub App settings
2. update mounted PEM file
3. restart API/worker pods
- PAT rotation:
1. issue new token
2. replace secret
3. revoke old token

## Least Privilege
- GitHub permissions restricted to:
- `contents:write`
- `pull_requests:write`
- `metadata:read`
- No admin scopes required.

## Logging and Redaction

### Logged
- run identifiers: `runId`, `campaignId`, `projectId`
- queue/job transitions
- workflow stage start/end
- error classes and failure kinds
- durations and retry counts

### Redacted / Not Logged
- Authorization headers
- token values (`ghp_`, bearer tokens, JWTs)
- private key material
- full signed URLs when they contain credentials/signature query params

### Redaction Rules
- sanitize token-like substrings in error output before persistence/logging
- redact `x-access-token:<value>@` patterns in git URLs
- do not include secret-bearing env vars in diagnostics

## Data Retention and Artifacts
- Evidence bundles include deterministic workflow outputs and checksums only.
- Run events are retained for pilot observability and troubleshooting.
- TTL cleanup jobs remove stale workspace/evidence cache directories.

## Incident Handling Basics
- Auth failures:
- verify app installation ID/app ID/private key path
- verify app repo access and permissions
- Queue stalls:
- inspect worker heartbeat/logs
- inspect `run_jobs` locks/timeouts and retry counters
- Secret exposure suspicion:
- rotate credentials immediately
- invalidate tokens
- preserve sanitized logs and audit run/event records
