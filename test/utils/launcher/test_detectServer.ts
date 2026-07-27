// Tests for `server/utils/launcher/detect-server.mjs` — telling "our
// server is already up" apart from "someone else has the port" and
// "nobody is there". Getting this wrong either starts a second server
// or hands the user a stranger's web page.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { classifyHealthProbe, detectRunningServer } from "../../../server/utils/launcher/detect-server.mjs";

describe("classifyHealthProbe", () => {
  it("reads a 401 as MulmoClaude — /api/health sits behind bearerAuth, so that IS our answer", () => {
    assert.equal(classifyHealthProbe({ status: 401, body: '{"error":"unauthorized"}' }), "mulmoclaude");
  });

  it("reads the real health body when auth is bypassed", () => {
    assert.equal(classifyHealthProbe({ status: 200, body: '{"status":"OK","version":"1.7.1"}' }), "mulmoclaude");
  });

  it("does not take a bare 200 as ours — any web server returns that", () => {
    assert.equal(classifyHealthProbe({ status: 200, body: "<html>someone else</html>" }), "foreign");
    assert.equal(classifyHealthProbe({ status: 200, body: '{"status":"different"}' }), "foreign");
    assert.equal(classifyHealthProbe({ status: 200 }), "foreign");
  });

  it("reads another app's 404 as foreign", () => {
    assert.equal(classifyHealthProbe({ status: 404, body: "not found" }), "foreign");
  });

  it("reads a connection error as nobody being there", () => {
    assert.equal(classifyHealthProbe({ errorCode: "ECONNREFUSED" }), "absent");
    assert.equal(classifyHealthProbe({ errorCode: "ETIMEDOUT" }), "absent");
  });
});

const listen = async (handler: Parameters<typeof createServer>[1]): Promise<Server> => {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
};

const portOf = (server: Server) => (server.address() as AddressInfo).port;

describe("detectRunningServer", () => {
  it("detects a bearer-protected MulmoClaude", async () => {
    const server = await listen((_req, res) => {
      res.writeHead(401);
      res.end('{"error":"unauthorized"}');
    });
    try {
      assert.equal(await detectRunningServer(portOf(server)), "mulmoclaude");
    } finally {
      server.close();
    }
  });

  it("detects an unrelated server on the port", async () => {
    const server = await listen((_req, res) => {
      res.writeHead(404);
      res.end("nope");
    });
    try {
      assert.equal(await detectRunningServer(portOf(server)), "foreign");
    } finally {
      server.close();
    }
  });

  it("resolves 'absent' instead of rejecting when nothing is listening", async () => {
    const server = await listen((_req, res) => res.end());
    const port = portOf(server);
    server.close();
    await once(server, "close");
    assert.equal(await detectRunningServer(port), "absent");
  });
});
