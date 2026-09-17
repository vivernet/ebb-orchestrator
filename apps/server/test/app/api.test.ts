import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app/create-app.js";

describe("orchestrator read API", () => {
  it.each([
    "/api/v1/dashboard",
    "/api/v1/projects/project-1",
    "/api/v1/epics/epic-1",
    "/api/v1/tasks/task-1",
    "/api/v1/execution",
    "/api/v1/approvals",
  ])("exposes %s as an authenticated read endpoint", async (url) => {
    const app = createApp();
    const response = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${app.sessionToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it.each([
    ["/api/v1/approvals/approval-1/approve", "POST"],
    ["/api/v1/tasks/task-1/pause", "POST"],
    ["/api/v1/runs/run-1/cancel", "POST"],
  ] as const)("rejects unauthenticated mutation %s", async (url, method) => {
    const app = createApp();
    const response = await app.inject({ method, url });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an authenticated mutation from an untrusted origin", async () => {
    const app = createApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/approval-1/approve",
      headers: {
        authorization: `Bearer ${app.sessionToken}`,
        origin: "https://evil.example",
      },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
