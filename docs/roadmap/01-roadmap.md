---
id: roadmap-01
status: completed
kind: roadmap
title: Ebb Orchestrator Roadmap
summary: Unified roadmap consolidating all stages and plans
created: 2026-09-16
updated: 2026-09-25
---

# Ebb Orchestrator Roadmap

**Version:** Roadmap 01
**Last Updated:** 2026-09-25
**Status:** Active

> This document is auto-generated from plan metadata. For manual edits, see [Governance Guide](../architecture/plans/governance/00-01-documentation-governance.md).

---

## Table of Contents

1. [Overview](#overview)
2. [Global Stage Register](#global-stage-register)
3. [Plan Register](#plan-register)
4. [Dependency Graph](#dependency-graph)
5. [Blockers and Evidence](#blockers-and-evidence)

---

## Overview

This roadmap consolidates all stages and plans into a single canonical document.

---

## Global Stage Register

| Stage | Total | Done | Progress |
|-------|-------|------|----------|
| 0 | 3 | 2 | 67% |
| 10 | 1 | 1 | 100% |
| 12 | 1 | 0 | 0% |
| 13 | 9 | 0 | 0% |
| 4 | 1 | 1 | 100% |
| 8 | 1 | 1 | 100% |
| 9 | 1 | 1 | 100% |
| A | 1 | 1 | 100% |
| B | 1 | 1 | 100% |
| C | 1 | 1 | 100% |
| D | 1 | 1 | 100% |
| undefined | 7 | 0 | 0% |

---

## Plan Register

| ID | Stage | Status | Title |
|----|-------|--------|-------|
| plan-04 | 4 | completed | Plan Document |
| plan-08-01 | A | completed | Web UI Recovery Stage A — Foundation & Shell |
| plan-08-02 | B | completed | Web UI Core Functional — Onboarding, Dashboard, Project |
| plan-08-03 | C | completed | Web UI Onboarding Flow & Projections |
| plan-08-04 | D | completed | Web UI Audit & Recovery Design |
| plan-10 | 10 | completed | Plan Document |
| plan-12 | 8 | completed | Web 401 и завершение проекта |
| plan-13 | 9 | completed | Автоматическая генерация роадмапа |
| plan-14 | 12 | planned | Дополнительный Docker runtime для Ebb Orchestrator |
| plan-15-01 | 13 | planned | Контракт auth и bounded crypto feasibility |
| plan-15-02 | 13 | planned | SQLite auth persistence и session repository |
| plan-15-03 | 13 | planned | First-run CLI wizard и startup composition |
| plan-15-04 | 13 | planned | Server auth routes, CSRF и security boundary |
| plan-15-05 | 13 | planned | Shared auth contract, Web login/restore и SSE expiry |
| plan-15-06 | 13 | planned | Atomic onboarding draft contract и scheduler guard |
| plan-15-07 | 13 | planned | Russian UI, accessibility и bootstrap artifact cleanup |
| plan-15-08 | 13 | planned | Verification, security evidence и independent plan review |
| plan-15 | 13 | planned | Устойчивые auth, onboarding и Russian Web UI |
| plan-00 | N/A | completed | Documentation Governance Refactoring |
| plan-00-02 | N/A | superseded | Plan Document |
| plan-00-03 | N/A | completed | Naming Convention for Implementation Plans |
| plan-00-05 | N/A | planned | Интеграция политик документации и governance |
| plan-08-01-merge | N/A | superseded | Stage 01 Merge Decisions |
| reference-01 | N/A | superseded | 01-baseline.md |
| ledger-01 | N/A | superseded | 02-progress-ledger.md |
| reference-02 | N/A | superseded | document-migration-map.md |
| plan-00-progress-ledger | N/A | superseded | Progress Ledger |
| ledger-05 | N/A | draft | Reconciliation ledger for plan-15 roadmap registration |

---

## Dependency Graph

plan-08-01 → plan-08-02
plan-08-02 → plan-08-03
plan-08-01 → plan-12
plan-09 → plan-13
plan-09 → plan-14
plan-11 → plan-14
plan-15-01 → plan-15-02
plan-15-02 → plan-15-03
plan-15-01 → plan-15-04
plan-15-02 → plan-15-04
plan-15-03 → plan-15-04
plan-15-04 → plan-15-05
plan-15-01 → plan-15-06
plan-15-04 → plan-15-06
plan-15-05 → plan-15-06
plan-15-05 → plan-15-07
plan-15-06 → plan-15-07
plan-15-03 → plan-15-08
plan-15-04 → plan-15-08
plan-15-05 → plan-15-08
plan-15-06 → plan-15-08
plan-15-07 → plan-15-08
plan-12 → plan-15
plan-13 → plan-15
plan-00-01 → plan-00-05
plan-00-04 → plan-00-05

---

## Blockers and Evidence

### Evidence Links

| Evidence ID | Type | Link |
|-------------|------|------|
| E001 | Full Audit | docs/audit/01-full-audit.md |
| E002 | Web UI Code Map | docs/audit/web-ui-code-map.md |
| E003 | Web UI Gap Analysis | docs/audit/web-ui-gap-analysis.md |
