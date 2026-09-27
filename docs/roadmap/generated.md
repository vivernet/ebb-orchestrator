---
id: roadmap-01
status: generated
kind: roadmap
title: Ebb Orchestrator Roadmap
summary: Generated from Plan metadata and dependencies
created: 2026-09-16
updated: 2026-09-27
---

# Ebb Orchestrator Roadmap

## Plan Register

| ID | Status | Title |
|----|--------|-------|
| plan-01 | completed | План реализации Foundation и Persistence Orchestrator |
| plan-02 | completed | План реализации домена Orchestrator, Workflow, Scheduler и Recovery |
| plan-03 | completed | План реализации Git, Execution и Security Orchestrator |
| plan-04 | completed | План реализации среды выполнения Orchestrator Hermes и автономной задачи |
| plan-05 | completed | План реализации планирования Orchestrator, эпиков, контекста, знаний и использования |
| plan-06 | completed | План реализации Web UI, GitHub и выпуска v1 Orchestrator |
| plan-07 | completed | План миграции процесса разработки Ebb Orchestrator с OpenCode на Hermes |
| plan-08-01 | completed | Web UI Foundation and Shell |
| plan-08-02 | completed | Web UI Core Functional — Onboarding, Dashboard, Project |
| plan-08-03 | completed | Web UI Onboarding Flow & Projections |
| plan-09 | completed | Production Readiness Hardening |
| plan-10 | completed | Ebb Orchestrator — Final V1 Audit & Hardening Plan (Перевод) |
| plan-11 | completed | Hermes Development Capabilities Implementation Plan |
| plan-12 | completed | Web 401 и завершение проекта |
| plan-13 | completed | Автоматическая генерация роадмапа |
| plan-14 | planned | Дополнительный Docker runtime для Ebb Orchestrator |
| plan-15-01 | completed | Контракт auth и bounded crypto feasibility |
| plan-15-02 | completed | SQLite auth persistence и session repository |
| plan-15-03 | completed | First-run CLI wizard и startup composition |
| plan-15-04 | completed | Server auth routes, CSRF и security boundary |
| plan-15-05 | completed | Shared auth contract, Web login/restore и SSE expiry |
| plan-15-06 | completed | Atomic onboarding draft contract и scheduler guard |
| plan-15-07 | completed | Russian UI, accessibility и bootstrap artifact cleanup |
| plan-15-08 | completed | Verification, security evidence и independent plan review |
| plan-15-09 | completed | Atomic auth v2 prerequisite remediation |
| plan-15 | completed | Устойчивые auth, onboarding и Russian Web UI |
| plan-16 | in_progress | Очистка и актуализация документации Ebb Orchestrator |
| plan-17 | planned | Надёжность CI evidence и единая конфигурация Ebb Orchestrator |
| plan-00 | completed | Documentation Governance Refactoring |
| plan-00-02 | superseded | Проверка и исправление политики AGENTS |
| plan-00-05 | completed | Интеграция политик документации и governance |

## Dependency Graph

plan-08-01 → plan-08-02
plan-08-02 → plan-08-03
plan-03 → plan-09
plan-08-01 → plan-12
plan-09 → plan-13
plan-09 → plan-14
plan-11 → plan-14
plan-15-01 → plan-15-02
plan-15-02 → plan-15-03
plan-15-01 → plan-15-04
plan-15-02 → plan-15-04
plan-15-03 → plan-15-04
plan-15-09 → plan-15-04
plan-15-04 → plan-15-05
plan-15-01 → plan-15-06
plan-15-04 → plan-15-06
plan-15-05 → plan-15-06
plan-15-05 → plan-15-07
plan-15-06 → plan-15-07
plan-15-03 → plan-15-08
plan-15-09 → plan-15-08
plan-15-04 → plan-15-08
plan-15-05 → plan-15-08
plan-15-06 → plan-15-08
plan-15-07 → plan-15-08
plan-15-01 → plan-15-09
plan-15-02 → plan-15-09
plan-15-03 → plan-15-09
plan-12 → plan-15
plan-13 → plan-15
plan-15-07 → plan-16
plan-15-08 → plan-16
plan-00 → plan-00-05
