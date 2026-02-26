# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Pilot reporting endpoint (`GET /reports/pilot`)
- Persistent PR lifecycle tracking fields on runs
- PR lifecycle poller worker for merge/close state tracking
- Pilot and release runbooks

## [0.1.x]

### Added
- Workspace isolation and evidence export
- Async queue worker with lease/retry semantics
- Campaign pause/resume and run cancel controls
- Project and campaign summary endpoints

## [1.0.0] (Placeholder)

### Planned GA Criteria
- Merge rate >= 60%
- Blocked rate <= 25%
- Time-to-green p90 <= 7 days
- Retry rate <= 20% over 30 days
