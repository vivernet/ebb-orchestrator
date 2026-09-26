import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { onboardingRoutes } from "../../src/app/routes/onboarding.js";
import type { OnboardingCommandService } from "../../src/modules/projects/onboarding-service.js";

const projection = { contractVersion: 1 as const, projectId: "p1", status: "DRAFT" as const, repository: { path: "/repo", remotes: [] }, detected: { root: "/repo", defaultBranch: "main", remotes: [], packageManager: "pnpm", languageHints: [], testCommands: [], untrustedExistingConfig: false }, proposed: null, approval: null };

describe("production onboarding composition seam", () => {
  it("forwards route commands only to the supplied service and never receives persistence dependencies", async () => {
    const calls: string[] = [];
    const service: OnboardingCommandService = {
      discoverAndCreateDraft: async () => { calls.push("discover"); return projection; },
      getProjection: () => { calls.push("get"); return projection; },
      requestApproval: () => { calls.push("request"); return projection; },
      approve: () => { calls.push("approve"); return projection; },
      activate: () => { calls.push("activate"); return projection; },
    };
    const app = Fastify();
    await onboardingRoutes(app, { onboardingService: service });
    const response = await app.inject({ method: "POST", url: "/api/v1/onboarding/p1/approval", payload: { proposed: { defaultBranch: "main", workflow: "standard", roles: ["Developer"], guidelines: [] } } });
    expect(response.statusCode).toBe(201);
    expect(calls).toEqual(["request"]);
    await app.close();
  });

  it("keeps one production Database/ApprovalService/OnboardingService composition and no route persistence calls", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const routes = readFileSync(new URL("../../src/app/routes/onboarding.ts", import.meta.url), "utf8");
    const createApp = readFileSync(new URL("../../src/app/create-app.ts", import.meta.url), "utf8");
    expect(main.match(/new ApprovalService\(database\)/g)).toHaveLength(1);
    expect(main.match(/new OnboardingService\(database, approvalService\)/g)).toHaveLength(1);
    expect(main).toContain("authService, approvalService, onboardingService");
    expect(createApp).not.toContain("new OnboardingService");
    expect(routes).not.toMatch(/db\.(get|run|transaction)|INSERT INTO|UPDATE .*onboarding|approvalService/);
  });
});
