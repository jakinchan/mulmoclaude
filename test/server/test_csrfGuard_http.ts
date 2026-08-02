// End-to-end HTTP integration tests for the CSRF guard.
//
// The unit tests in `test_csrfGuard.ts` pin the pure logic and the
// factory; this file exercises the full wired stack — a real
// Express app, a real `http.Server`, real sockets, real HTTP
// requests with an `Origin` header. That catches a class of
// regressions the unit tests can't, e.g. someone refactors
// `server/index.ts` and forgets the `app.use(requireSameOrigin)`
// line, or the middleware-order changes so a body parser swallows
// the request before the guard runs.
//
// We don't pull in supertest (not in the dep tree, per
// `test/sources/test_sourcesRoute.ts`); `node:http` + `fetch` is
// enough for the few endpoint shapes we need to cover.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { requireSameOriginWith } from "../../server/api/csrfGuard.js";

interface AppFixture {
  baseUrl: string;
  close: () => Promise<void>;
}

// Build a minimal Express app wired with the CSRF guard for a given
// trusted-origins allowlist, expose POST /api/wiki + GET /api/wiki
// stub handlers, and bind to an ephemeral port. Returns the
// baseUrl + a cleanup hook.
async function startApp(trustedOrigins: readonly string[]): Promise<AppFixture> {
  const app = express();
  app.use(express.json());
  app.use(requireSameOriginWith(trustedOrigins));
  app.post("/api/wiki", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/api/wiki", (_req, res) => {
    res.json({ ok: true });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

interface PostOptions {
  origin?: string;
  method?: "POST" | "GET";
}

// Wraps the boilerplate `fetch`. Returns status only — the bodies
// are uniform `{ ok: true }` or `{ error: "..." }` and aren't the
// security-relevant signal.
async function send(baseUrl: string, opts: PostOptions = {}): Promise<number> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.origin !== undefined) headers["Origin"] = opts.origin;
  const res = await fetch(`${baseUrl}/api/wiki`, {
    method: opts.method ?? "POST",
    headers,
    ...(opts.method === "GET" ? {} : { body: JSON.stringify({ action: "page", pageName: "test" }) }),
  });
  return res.status;
}

describe("CSRF guard — HTTP integration (default-deny: empty allowlist)", () => {
  let fixture: AppFixture;
  before(async () => {
    fixture = await startApp([]);
  });
  after(async () => {
    await fixture.close();
  });

  it("403s a POST whose Origin is a LAN IP (the bug-was-here pin)", async () => {
    // Reproduction of the original symptom: iPad on the LAN sends
    // POST /api/wiki, browser attaches `Origin: http://192.168.x.x:5173`,
    // empty allowlist means the guard rejects it.
    const status = await send(fixture.baseUrl, { origin: "http://192.168.72.101:5173" });
    assert.equal(status, 403);
  });

  it("403s a POST with `Origin: null` (sandboxed iframe / file:// surface)", async () => {
    const status = await send(fixture.baseUrl, { origin: "null" });
    assert.equal(status, 403);
  });

  it("200s a POST from http://localhost:5173 (Vite dev) — localhost always allowed", async () => {
    const status = await send(fixture.baseUrl, { origin: "http://localhost:5173" });
    assert.equal(status, 200);
  });

  it("200s a POST with no Origin header (non-browser caller)", async () => {
    const status = await send(fixture.baseUrl);
    assert.equal(status, 200);
  });

  it("200s a GET with an off-localhost Origin (safe method)", async () => {
    const status = await send(fixture.baseUrl, { method: "GET", origin: "http://192.168.72.101:5173" });
    assert.equal(status, 200);
  });
});

describe("CSRF guard — HTTP integration (opt-in: LAN origin allowlisted)", () => {
  const LAN_IPAD = "http://192.168.72.101:5173";
  let fixture: AppFixture;
  before(async () => {
    fixture = await startApp([LAN_IPAD]);
  });
  after(async () => {
    await fixture.close();
  });

  it("200s a POST from the allowlisted LAN origin (Wiki-from-iPad happy path)", async () => {
    const status = await send(fixture.baseUrl, { origin: LAN_IPAD });
    assert.equal(status, 200);
  });

  it("403s a POST from a different LAN origin not on the list", async () => {
    const status = await send(fixture.baseUrl, { origin: "http://192.168.72.99:5173" });
    assert.equal(status, 403);
  });

  it("403s a POST from the allowlisted origin with a different port", async () => {
    const status = await send(fixture.baseUrl, { origin: "http://192.168.72.101:3001" });
    assert.equal(status, 403);
  });

  it("200s a POST from localhost (still allowed regardless of list)", async () => {
    const status = await send(fixture.baseUrl, { origin: "http://localhost:5173" });
    assert.equal(status, 200);
  });
});

describe("CSRF guard — HTTP integration (`null` hardening: listed but rejected)", () => {
  // Defense-in-depth: even if the operator typoed `null` into the
  // env var, the wired stack must reject it. This pins the
  // iteration-1 hardening at the HTTP layer.
  let fixture: AppFixture;
  before(async () => {
    fixture = await startApp(["null", "http://192.168.72.101:5173"]);
  });
  after(async () => {
    await fixture.close();
  });

  it("403s a POST with `Origin: null` even when `null` is in the trusted list", async () => {
    const status = await send(fixture.baseUrl, { origin: "null" });
    assert.equal(status, 403);
  });

  it("still 200s a POST from the legitimate LAN entry in the same list", async () => {
    const status = await send(fixture.baseUrl, { origin: "http://192.168.72.101:5173" });
    assert.equal(status, 200);
  });
});
