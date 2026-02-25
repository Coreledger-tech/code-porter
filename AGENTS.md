# Code Porter Agent Working Agreements

## Operating Rules
- Always run relevant tests after making changes.
- Prefer small, reviewable commits with meaningful commit messages.
- Never introduce heavy dependencies without a written justification in the PR or commit notes.
- Never delete user data.
- Never run destructive commands (for example `rm`, `git reset --hard`, force-push, or destructive DB operations) without explicit confirmation in chat.

## Engineering Style
- Keep the system deterministic-first: recipes/codemods before agentic repair.
- Keep safety rails on: compile, tests (if present), and static checks gate execution.
- Keep evidence-first: every run must produce structured evidence artifacts.
- Keep policy-driven behavior: decisions must come from YAML policy and be recorded.

## Collaboration
- If environment/tooling is missing, degrade gracefully and record the reason in evidence.
- If assumptions are made, document them in run evidence and docs.
