import type { FastifyInstance } from "fastify";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Database } from "../../platform/database/database.js";
import { OnboardingService } from "../../modules/projects/onboarding-service.js";
import type { Approval, ApprovalRequestInput } from "../../modules/approvals/approval-types.js";

export interface OnboardingCommandService {
  onboard(repoPath: string): Promise<{ facts: {
    root: string; defaultBranch: string; remotes: readonly { name: string; url: string }[];
    packageManager: string; languageHints: readonly string[]; testCommands: readonly string[];
    untrustedExistingConfig: boolean;
  }; onboardingStatus: "new" | "existing" }>;
}
export interface OnboardingApprovalService {
  request(input: ApprovalRequestInput): Approval;
  approve(approvalId: string, actor: string, note?: string): Approval;
}
export interface OnboardingRouteDeps {
  db?: Database | undefined;
  onboardingService?: OnboardingCommandService | undefined;
  approvalService?: OnboardingApprovalService | undefined;
}

interface ProjectRow { id: string; name: string; status: string; }
interface OnboardingRow {
  project_id: string; repository_path: string; facts_json: string; proposed_json: string;
  status: "PROPOSED" | "ACTIVE"; approval_id: string | null; activated_at: string | null;
}
interface ApprovalRow { id: string; status: string; resolved_at: string | null; }

/**
 * Регистрирует discovery, persisted semantic approval и activation onboarding.
 * Репозиторий принимается только как существующий абсолютный каталог; ответы
 * никогда не возвращают credential-bearing remote URL или содержимое секретов.
 */
export async function onboardingRoutes(app: FastifyInstance, deps: OnboardingRouteDeps = {}): Promise<void> {
  const discovery = deps.onboardingService ?? new OnboardingService();

  app.post<{ Body: unknown }>("/api/v1/onboarding/discover", async (request, reply) => {
    if (!deps.db || !deps.onboardingService) return reply.code(503).send({ error: "onboarding service unavailable" });
    const body = parseDiscoveryBody(request.body);
    if (!body) return reply.code(400).send({ error: "invalid repository path" });
    const repositoryPath = validateRepositoryPath(body.repositoryPath);
    if (!repositoryPath) return reply.code(400).send({ error: "invalid repository path" });
    try {
      const result = await discovery.onboard(repositoryPath);
      return { repository: { path: result.facts.root, remotes: redactRemotes(result.facts.remotes) }, detected: sanitizeFacts(result.facts), onboardingStatus: result.onboardingStatus };
    } catch { return reply.code(400).send({ error: "repository discovery failed" }); }
  });

  app.get<{ Params: { id: string } }>("/api/v1/onboarding/:id", async (request, reply) => {
    if (!deps.db) return reply.code(503).send({ error: "database unavailable" });
    const project = deps.db.get<ProjectRow>("SELECT id,name,status FROM projects WHERE id=$id", { id: request.params.id });
    if (!project) return reply.code(404).send({ error: "project not found" });
    const config = deps.db.get<OnboardingRow>("SELECT project_id,repository_path,facts_json,proposed_json,status,approval_id,activated_at FROM onboarding_configs WHERE project_id=$id", { id: project.id });
    const approval = deps.db.get<{ id: string; status: string }>("SELECT id,status FROM approvals WHERE subject_id=$id AND subject_type='PROJECT' AND type='WORKFLOW_CHANGE' ORDER BY created_at DESC LIMIT 1", { id: project.id });
    return projectView(project.id, config, approval);
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/onboarding/:id/approval", async (request, reply) => {
    if (!deps.db || !deps.approvalService || !deps.onboardingService) return reply.code(503).send({ error: "onboarding approval service unavailable" });
    const project = deps.db.get<ProjectRow>("SELECT id,name,status FROM projects WHERE id=$id", { id: request.params.id });
    if (!project) return reply.code(404).send({ error: "project not found" });
    const body = parseApprovalBody(request.body);
    if (!body) return reply.code(400).send({ error: "invalid onboarding approval body" });
    const repositoryPath = validateRepositoryPath(body.repositoryPath);
    if (!repositoryPath) return reply.code(400).send({ error: "invalid repository path" });
    const pending = deps.db.get("SELECT id FROM approvals WHERE subject_id=$id AND subject_type='PROJECT' AND type='WORKFLOW_CHANGE' AND status='PENDING'", { id: project.id });
    if (pending) return reply.code(409).send({ error: "semantic config approval already pending" });
    let discovered;
    try { discovered = await discovery.onboard(repositoryPath); } catch { return reply.code(400).send({ error: "repository discovery failed" }); }
    const proposed = body.proposed ?? defaultProposal(discovered.facts.defaultBranch);
    const facts = sanitizeFacts(discovered.facts);
    const metadata = { kind: "semantic-config", repositoryPath, facts, proposed };
    try {
      const approval = deps.approvalService.request({ type: "WORKFLOW_CHANGE", subjectId: project.id, subjectType: "PROJECT", requestedBy: "local-user", metadata });
      const now = new Date().toISOString();
      deps.db.run(`INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,$repositoryPath,$facts,$proposed,'PROPOSED',$approvalId,$now,$now)
        ON CONFLICT(project_id) DO UPDATE SET repository_path=excluded.repository_path,facts_json=excluded.facts_json,proposed_json=excluded.proposed_json,status='PROPOSED',approval_id=excluded.approval_id,updated_at=excluded.updated_at,activated_at=NULL`, { projectId: project.id, repositoryPath, facts: JSON.stringify(facts), proposed: JSON.stringify(proposed), approvalId: approval.id, now });
      return reply.code(201).send({ approval: safeApproval(approval), onboarding: { projectId: project.id, status: "PROPOSED" } });
    } catch (error) {
      if (error instanceof Error && /already|unique|constraint/i.test(error.message)) return reply.code(409).send({ error: "semantic config approval conflict" });
      return reply.code(503).send({ error: "failed to persist onboarding approval" });
    }
  });

  app.post<{ Params: { id: string }; Body?: { note?: string } }>("/api/v1/onboarding/:id/approve", async (request, reply) => {
    if (!deps.db || !deps.approvalService) return reply.code(503).send({ error: "onboarding approval service unavailable" });
    const project = deps.db.get<ProjectRow>("SELECT id,name,status FROM projects WHERE id=$id", { id: request.params.id });
    if (!project) return reply.code(404).send({ error: "project not found" });
    const row = deps.db.get<{ id: string }>("SELECT id FROM approvals WHERE subject_id=$id AND subject_type='PROJECT' AND type='WORKFLOW_CHANGE' AND status='PENDING' ORDER BY created_at DESC LIMIT 1", { id: project.id });
    if (!row) return reply.code(409).send({ error: "semantic config approval is not pending" });
    try { return { approval: safeApproval(deps.approvalService.approve(row.id, "local-user", request.body?.note)) }; }
    catch { return reply.code(409).send({ error: "semantic config approval is no longer pending" }); }
  });

  app.post<{ Params: { id: string } }>("/api/v1/onboarding/:id/activate", async (request, reply) => {
    if (!deps.db) return reply.code(503).send({ error: "database unavailable" });
    const project = deps.db.get<ProjectRow>("SELECT id,name,status FROM projects WHERE id=$id", { id: request.params.id });
    if (!project) return reply.code(404).send({ error: "project not found" });
    const approval = deps.db.get<ApprovalRow>("SELECT id,status,resolved_at FROM approvals WHERE subject_id=$id AND subject_type='PROJECT' AND type='WORKFLOW_CHANGE' AND status='APPROVED' ORDER BY resolved_at DESC LIMIT 1", { id: project.id });
    if (!approval) return reply.code(409).send({ error: "onboarding activation requires approved semantic approval" });
    const config = deps.db.get<OnboardingRow>("SELECT project_id,repository_path,facts_json,proposed_json,status,approval_id,activated_at FROM onboarding_configs WHERE project_id=$id", { id: project.id });
    if (!config || config.approval_id !== approval.id) return reply.code(409).send({ error: "approved onboarding proposal is missing" });
    const now = new Date().toISOString();
    deps.db.run("UPDATE onboarding_configs SET status='ACTIVE',updated_at=$now,activated_at=$now WHERE project_id=$id AND approval_id=$approvalId", { id: project.id, approvalId: approval.id, now });
    return { projectId: project.id, status: "ACTIVE", semanticConfigApproved: true, localModeEnabled: true, approvalId: approval.id };
  });
}

function parseDiscoveryBody(value: unknown): { repositoryPath: string } | null { if (!isPlainObject(value) || Object.keys(value).length !== 1 || typeof value.repositoryPath !== "string") return null; return { repositoryPath: value.repositoryPath }; }
function parseApprovalBody(value: unknown): { repositoryPath: string; proposed?: Record<string, unknown> } | null {
  if (!isPlainObject(value) || typeof value.repositoryPath !== "string") return null;
  if (Object.keys(value).some((key) => !["repositoryPath", "proposed"].includes(key))) return null;
  if (value.proposed === undefined) return { repositoryPath: value.repositoryPath };
  const proposed = parseProposal(value.proposed);
  return proposed ? { repositoryPath: value.repositoryPath, proposed } : null;
}
function parseProposal(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  const allowed = ["defaultBranch", "workflow", "roles", "guidelines"] as const;
  if (Object.keys(value).some((key) => !allowed.includes(key as typeof allowed[number]))) return null;
  if (value.defaultBranch !== undefined && !isNonEmptyString(value.defaultBranch)) return null;
  if (value.workflow !== undefined && !isNonEmptyString(value.workflow)) return null;
  for (const key of ["roles", "guidelines"] as const) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || !value[key].every(isNonEmptyString))) return null;
  }
  return { ...value };
}
function isPlainObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function validateRepositoryPath(value: string): string | null { if (!isAbsolute(value) || value.includes("\0")) return null; try { const real = realpathSync(value); return statSync(real).isDirectory() ? real : null; } catch { return null; } }
function redactRemotes(remotes: readonly { name: string; url: string }[]): { name: string; url: string }[] { return remotes.map((remote) => ({ name: remote.name, url: redactRemote(remote.url) })); }
function redactRemote(url: string): string { try { const parsed = new URL(url); if (parsed.username || parsed.password) { parsed.username = "***"; parsed.password = "***"; } parsed.search = ""; parsed.hash = ""; return parsed.toString(); } catch { return "[redacted]"; } }
function sanitizeFacts(facts: { root: string; defaultBranch: string; remotes: readonly { name: string; url: string }[]; packageManager: string; languageHints: readonly string[]; testCommands: readonly string[]; untrustedExistingConfig: boolean }) { return { root: facts.root, defaultBranch: facts.defaultBranch, remotes: redactRemotes(facts.remotes), packageManager: facts.packageManager, languageHints: [...facts.languageHints], testCommands: [...facts.testCommands], untrustedExistingConfig: facts.untrustedExistingConfig }; }
function defaultProposal(defaultBranch: string): Record<string, unknown> { return { defaultBranch, workflow: "standard", roles: ["Developer", "Reviewer", "QA"], guidelines: [] }; }
function safeApproval(approval: Approval): Omit<Approval, "metadata"> { const { metadata: _metadata, ...safe } = approval; return safe; }
function projectView(projectId: string, config: OnboardingRow | undefined, approval: { id: string; status: string } | undefined) { let facts: Record<string, unknown> = { defaultBranch: null, packageManager: null, testFramework: null, orchestratorConfigFound: false }; let proposed: Record<string, unknown> = { defaultBranch: null, workflow: null, roles: [], guidelines: [] }; if (config) { try { const parsed = JSON.parse(config.facts_json) as Record<string, unknown>; facts = { defaultBranch: parsed.defaultBranch ?? null, packageManager: parsed.packageManager ?? null, testFramework: null, orchestratorConfigFound: parsed.untrustedExistingConfig ?? false }; proposed = JSON.parse(config.proposed_json) as Record<string, unknown>; } catch { /* fail closed to empty projection */ } } return { projectId, repository: { path: config?.repository_path ?? null, remoteUrl: null }, detected: facts, proposed, approvalStatus: approval?.status ?? "PENDING", semanticConfigApproved: approval?.status === "APPROVED" && config?.status === "ACTIVE", localModeEnabled: config?.status === "ACTIVE" }; }
