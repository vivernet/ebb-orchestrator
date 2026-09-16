import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app/create-app.js";

describe("GET /api/v1/health", () => {
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
