# Code Porter Roadmap

## Product Lanes
- **V1 Upgrade Factory**: deterministic JVM modernization with policy gates and evidence.
- **V2 Legacy Modernization**: COBOL/Fortran/PLSQL discovery, translation, parity and strangler rollout.

## Updated Epics
1. **Agent Runtime and Tooling Layer**
   - Runner abstraction (local, CI, agentic, future MCP adapters).
2. **Repository Discovery and Mapping**
   - Build-system and language-aware scanning; dependency and coupling metadata.
3. **Deterministic Recipe Factory**
   - Repeatable codemods with explainable plans and minimal patch output.
4. **Verifier and Policy Gating**
   - Compile/test/static checks with enforceable org policy.
5. **Evidence and Auditability**
   - Provenance artifacts, policy decisions, confidence outputs.
6. **Knowledge Layer (Dosu-ready)**
   - Living modernization summaries and decision logs.
7. **Durable Orchestration (DBOS-ready)**
   - Checkpointable campaign workflows and resumability hooks.
8. **Legacy Truth-Set Generator**
   - Characterization tests and parity baselines for legacy lanes.
9. **Incremental Migration Engine**
   - Side-by-side modernization, controlled cutover, rollback.
10. **Developer UX and Integration Surfaces**
   - CLI/API-first, GitHub automation later.

## Milestones
### 0-12 Weeks (V1)
- **M0 (Week 0-2)**: control plane basics, evidence v1, local runner.
- **M1 (Week 2-5)**: deterministic recipes for Java upgrade path.
- **M2 (Week 4-7)**: agentic repair contract + stub and verifier feedback integration.
- **M3 (Week 6-9)**: policy hardening, rehearsal mode, confidence thresholds.
- **M4 (Week 8-10)**: DBOS-compatible workflow contracts and stub adapter.
- **M5 (Week 10-12)**: knowledge publication hooks and docs context export.

### Month 1-6 (V2)
- **L0**: COBOL/Fortran/PLSQL discovery and intermediate representation.
- **L1**: characterization tests and truth-set harness.
- **L2**: translation pipeline with parity and round-trip checks.
- **L3**: assurance tier for critical kernels.
- **L4**: data/batch migration lanes.
- **L5**: strangler rollout with dual-run comparator and rollback.
