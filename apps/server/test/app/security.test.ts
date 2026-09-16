import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app/create-app.js";

describe("local-session security", () => {
  it("rejects unauthenticated requests to protected routes with 401", async () => {
    const app = createApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/protected-test",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("allows authenticated requests to protected routes", async () => {
    const app = createApp();
    const token = app.sessionToken;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/protected-test",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects requests with invalid origin on mutating routes with 403", async () => {
    const app = createApp();
    const token = app.sessionToken;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/protected-test",
      headers: {
        origin: "https://evil.example.com",
        authorization: `Bearer ${token}`,
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("allows requests without origin header (same-origin)", async () => {
    const app = createApp();
    const token = app.sessionToken;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/protected-test",
      headers: { authorization: `Bearer ${token}` },
      // No origin header – should succeed (same-origin / non-CORS).
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("allows requests with matching origin", async () => {
    const app = createApp();
    const token = app.sessionToken;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/protected-test",
      headers: {
        origin: "http://127.0.0.1:3000",
        authorization: `Bearer ${token}`,
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
