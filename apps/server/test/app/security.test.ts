import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app/create-app.js";

describe("local-session security", () => {
  it("bootstraps a distinct CSRF token without persisting it", async () => {
    const app = createApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/session/bootstrap" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ sessionToken: app.sessionToken, csrfToken: app.csrfToken });
    expect(app.csrfToken).not.toBe(app.sessionToken);
    await app.close();
  });

  it("rejects unauthenticated requests to protected routes with 401", async () => {
    const app = createApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/protected-test",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("requires same-origin validation for authenticated mutations", async () => {
    const app = createApp();
    const token = app.sessionToken;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/protected-test",
        headers: { authorization: `Bearer ${token}`, origin: "http://127.0.0.1:3000", "x-csrf-token": app.csrfToken },
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

  it("rejects same-origin mutations without the CSRF token", async () => {
    const app = createApp();
    const res = await app.inject({ method: "POST", url: "/api/v1/protected-test", headers: { authorization: `Bearer ${app.sessionToken}`, origin: "http://127.0.0.1:3000" } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects requests without origin header to prevent CSRF", async () => {
    const app = createApp();
    const token = app.sessionToken;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/protected-test",
      headers: { authorization: `Bearer ${token}` },
      // No origin header – should succeed (same-origin / non-CORS).
    });
    expect(res.statusCode).toBe(403);
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
        "x-csrf-token": app.csrfToken,
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
