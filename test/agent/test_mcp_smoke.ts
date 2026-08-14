// Smoke test: spawn the MCP server as a real subprocess (the same way
// Claude CLI does) and verify it can initialize + list tools.
//
// This catches import-resolution failures that typecheck and unit
// tests miss because they run in the main process context. The MCP
// server is a standalone tsx subprocess — if any import path is
// broken, it crashes on startup before responding to JSON-RPC.
//
// See PR #424 for the bug this test prevents from recurring.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { ONE_SECOND_MS } from "../../server/utils/time.ts";
import { buildMulmoclaudeServer } from "../../server/agent/config.ts";
import { API_ROUTES } from "../../src/config/apiRoutes.ts";
import { TOOL_NAMES } from "../../src/config/toolNames.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const MCP_SERVER = path.join(PROJECT_ROOT, "server/agent/mcp-server.ts");
// Use npx tsx so the shell resolves .cmd wrappers on Windows.
const TSX = path.join(PROJECT_ROOT, "node_modules", ".bin", "tsx");

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: {
    protocolVersion?: string;
    capabilities?: { tools?: { listChanged?: boolean } };
    serverInfo?: { name: string };
    tools?: { name: string; description: string }[];
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

interface BrokerStreams {
  /** Raw stdout, for asserting the JSON-RPC channel carries nothing else. */
  stdout: string;
  stderr: string;
}

interface BrokerRun extends BrokerStreams {
  responses: JsonRpcResponse[];
}

/** The JSON-RPC messages in the broker's stdout. Non-JSON lines are skipped here
 *  so a malformed line surfaces as "no responses" rather than a parse throw —
 *  the stdout-purity test asserts their absence directly. */
function parseJsonRpcResponses(stdout: string): JsonRpcResponse[] {
  const parsed: JsonRpcResponse[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line) as JsonRpcResponse);
    } catch {
      continue;
    }
  }
  return parsed;
}

function captureStreams(child: ChildProcess): { text: BrokerStreams } {
  const captured = { text: { stdout: "", stderr: "" } };
  child.stdout?.on("data", (chunk: Buffer) => {
    captured.text.stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    captured.text.stderr += chunk.toString();
  });
  return captured;
}

function sendLines(child: ChildProcess, lines: string[]): void {
  // Send all lines, then close stdin to signal EOF.
  for (const line of lines) {
    child.stdin?.write(`${line}\n`);
  }
  child.stdin?.end();
}

function brokerRunOrThrow(code: number | null, streams: BrokerStreams): BrokerRun {
  if (code !== 0) throw new Error(`MCP server exited with code ${code}. stderr: ${streams.stderr.slice(0, 500)}`);
  const responses = parseJsonRpcResponses(streams.stdout);
  if (responses.length === 0) throw new Error(`MCP server produced no valid JSON-RPC responses. stdout: ${streams.stdout.slice(0, 500)}`);
  return { responses, ...streams };
}

function runBroker(lines: string[], env: Record<string, string>, command = `"${TSX}" "${MCP_SERVER}"`): Promise<BrokerRun> {
  return new Promise((resolve, reject) => {
    // shell: true so Windows resolves .cmd wrappers in node_modules/.bin/.
    // Pass args as a single command string to avoid DEP0190 warning.
    const child = spawn(command, { cwd: PROJECT_ROOT, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], shell: true });
    const captured = captureStreams(child);
    sendLines(child, lines);

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`MCP server timed out. stderr: ${captured.text.stderr}`));
    }, 15 * ONE_SECOND_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        resolve(brokerRunOrThrow(code, captured.text));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

async function sendAndReceive(lines: string[], env: Record<string, string>): Promise<JsonRpcResponse[]> {
  const { responses } = await runBroker(lines, env);
  return responses;
}

const initializeRequest = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } },
});
const initializedNotification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
const toolsListRequest = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

// Distinctive so a mismatch names itself in the assertion message rather than
// reading as an empty-string coincidence.
const BEACON_SPAWN_ID = "spawn-smoke-7f3a";

function isJsonLine(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

describe("MCP server subprocess smoke test", () => {
  it("responds to initialize + tools/list with registered tools", async () => {
    const env: Record<string, string> = {
      SESSION_ID: "test-smoke",
      PORT: "0",
      PLUGIN_NAMES: [TOOL_NAMES.manageSkills, TOOL_NAMES.presentMulmoScript].join(","),
    };

    const responses = await sendAndReceive(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.0" },
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      ],
      env,
    );

    // Should get exactly 2 responses (initialize + tools/list).
    assert.ok(responses.length >= 2, `Expected >= 2 responses, got ${responses.length}: ${JSON.stringify(responses)}`);

    // Initialize response
    const initResp = responses.find((resp) => resp.id === 1);
    assert.ok(initResp, "Missing initialize response");
    assert.ok(initResp.result, "Initialize response has no result");
    assert.equal(initResp.result.serverInfo?.name, "mulmoclaude");

    // Must advertise tools/list_changed so the client re-fetches once
    // runtime plugins finish loading (#1698 — the static tools/list now
    // returns immediately rather than waiting for that load).
    assert.equal(initResp.result.capabilities?.tools?.listChanged, true, "initialize must advertise capabilities.tools.listChanged");

    // tools/list response
    const toolsResp = responses.find((resp) => resp.id === 2);
    assert.ok(toolsResp, "Missing tools/list response");
    assert.ok(toolsResp.result?.tools, "tools/list has no tools array");
    assert.ok(Array.isArray(toolsResp.result.tools), "tools is not an array");

    // The tools we requested via PLUGIN_NAMES should be present.
    const toolNames = toolsResp.result.tools.map((tool: { name: string }) => tool.name);
    assert.ok(toolNames.includes(TOOL_NAMES.manageSkills), `${TOOL_NAMES.manageSkills} not in tools: ${toolNames.join(", ")}`);
    assert.ok(toolNames.includes(TOOL_NAMES.presentMulmoScript), `${TOOL_NAMES.presentMulmoScript} not in tools: ${toolNames.join(", ")}`);

    // manageWiki is intentionally absent (#963 Stage 3b) — the MCP
    // tool definition was removed; the plugin record stays for
    // canvas dispatch only, not for LLM-side calls.
    assert.ok(!toolNames.includes(TOOL_NAMES.manageWiki), `${TOOL_NAMES.manageWiki} should not be exposed via MCP: ${toolNames.join(", ")}`);

    // The always-on permission-prompt tool MUST appear in the very first
    // tools/list, so an ask-mode permission check at session start never
    // hits "MCP tool mcp__mulmoclaude__handlePermission ... not found" (#1698).
    assert.ok(toolNames.includes("handlePermission"), `handlePermission not in tools: ${toolNames.join(", ")}`);
  });

  // `name` comes from the model, so it can be any JSON type. It used to be read
  // as `String(args.name ?? "")`, which turns an object into the literal
  // "[object Object]" — POSTed to /api/skills as a skill name and read back to
  // the user as one. The guard must reject it before any of that.
  //
  // Driven through the subprocess because mcp-server.ts is an stdio entry point
  // with no exports; there is no unit-level seam to reach the guard.
  it("rejects a non-string skill name instead of acting on [object Object]", async () => {
    const env: Record<string, string> = {
      SESSION_ID: "test-smoke-bad-name",
      PORT: "0",
      PLUGIN_NAMES: TOOL_NAMES.manageSkills,
    };

    const responses = await sendAndReceive(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: TOOL_NAMES.manageSkills,
            arguments: { action: "save", name: { nested: "oops" }, description: "d", body: "b" },
          },
        }),
      ],
      env,
    );

    const call = responses.find((response) => response.id === 2);
    assert.ok(call, `no response for tools/call: ${JSON.stringify(responses)}`);

    const text = JSON.stringify(call);
    // The guard's message, not an HTTP failure from the unreachable PORT=0 —
    // proving it fired before the request was attempted.
    assert.match(text, /name.{0,40}must be a non-empty string/i, `expected the name guard to fire, got: ${text.slice(0, 400)}`);
    assert.doesNotMatch(text, /\[object Object\]/, `the object name reached the API path: ${text.slice(0, 400)}`);
  });

  // stdout IS the protocol channel here, yet the shared `log` helper sends
  // info/debug there by default — the plugin loaders' "loaded" lines landed
  // between JSON-RPC messages on every boot (#2731). Only the parent knows the
  // child's stdout is a protocol stream, so the env comes from
  // `buildMulmoclaudeServer` rather than a hand-copied literal that could drift
  // from it. The source broker is driven rather than `spec.command`, which
  // prefers the `yarn build:mcp-broker` bundle: a stale bundle would fail this
  // for a reason that has nothing to do with the source under test.
  it("keeps stdout free of log lines when spawned with the parent's env", async () => {
    const spec = buildMulmoclaudeServer({
      chatSessionId: "test-stdout-purity",
      port: 0,
      activePlugins: [TOOL_NAMES.google],
      useDocker: false,
    });
    const { stdout } = await runBroker([initializeRequest, initializedNotification, toolsListRequest], spec.env);

    const junk = stdout
      .split("\n")
      .filter((line) => line.trim())
      .filter((line) => !isJsonLine(line));
    assert.deepEqual(junk, [], `non-JSON lines on the JSON-RPC channel: ${junk.join(" | ").slice(0, 400)}`);
  });

  // The parent describes every PLUGIN_NAMES entry to the LLM, so a name that
  // resolves to no tool is a tool the agent is told to call and cannot. Before
  // #2731 that state was invisible without hand-driving the broker over stdio.
  it("reports the published surface and names anything advertised but not published", async () => {
    const { stderr } = await runBroker([initializeRequest, initializedNotification, toolsListRequest], {
      SESSION_ID: "test-published-surface",
      PORT: "0",
      PLUGIN_NAMES: `${TOOL_NAMES.google},noSuchPlugin`,
      LOG_CONSOLE_STREAM: "stderr",
    });

    // `google` is a preset runtime plugin: its presence proves the child loads
    // presets, which the issue's hypothesis said it did not.
    assert.match(
      stderr,
      new RegExp(`publishing \\d+ tools: [^\\n]*\\b${TOOL_NAMES.google}\\b`),
      `expected the published surface on stderr: ${stderr.slice(-600)}`,
    );
    assert.match(stderr, /advertised but NOT published[^\n]*noSuchPlugin/, `expected the missing-tool diagnostic: ${stderr.slice(-600)}`);
  });

  // #2842: the broker's own stderr belongs to Claude CLI, so this beacon is the
  // only way its cold-boot timing reaches the host. The route's unit test covers
  // the receiving half; what it cannot show is that the broker actually SENDS
  // one — and a beacon that silently stopped firing would restore exactly the
  // blindness the issue was filed about, with every other test still green.
  it("POSTs a startup beacon to the host once it answers initialize", async () => {
    const received: { path: string; body: string }[] = [];
    const host = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({ path: req.url ?? "", body: Buffer.concat(chunks).toString() });
        res.statusCode = 204;
        res.end();
      });
    });
    host.listen(0, "127.0.0.1");
    await once(host, "listening");
    const port = listeningPort(host);

    try {
      await runBroker([initializeRequest, initializedNotification], {
        SESSION_ID: "test-beacon",
        MCP_SPAWN_ID: BEACON_SPAWN_ID,
        PORT: String(port),
        MCP_HOST: "127.0.0.1",
        PLUGIN_NAMES: TOOL_NAMES.manageSkills,
        LOG_CONSOLE_STREAM: "stderr",
      });
    } finally {
      await closeServer(host);
    }

    const beacon = received.find((entry) => entry.path.startsWith(API_ROUTES.mcp.brokerReady));
    assert.ok(beacon, `no beacon on ${API_ROUTES.mcp.brokerReady}; got: ${received.map((entry) => entry.path).join(", ") || "nothing"}`);
    assert.match(beacon.path, /[?&]session=test-beacon\b/, `beacon must carry the session it belongs to: ${beacon.path}`);

    const payload: unknown = JSON.parse(beacon.body);
    assert.ok(isBeaconPayload(payload), `unexpected beacon body: ${beacon.body}`);
    // `tsx` here because the test drives the source broker, not the bundle —
    // the field has to report the path actually taken, which is the whole point
    // of it existing.
    assert.equal(payload.kind, "tsx");
    assert.ok(payload.bootMs > 0, `bootMs should measure real startup, got ${payload.bootMs}`);
    assert.ok(payload.initializeMs >= payload.bootMs, `initialize cannot precede module load: ${JSON.stringify(payload)}`);
    // The half no unit test can reach: the id the parent puts in the broker's
    // env has to come back out in the beacon body. Without that round-trip the
    // host cannot tell a straggler from the current attempt, and the failure is
    // silent — every beacon would simply be discarded as superseded.
    assert.equal(payload.spawnId, BEACON_SPAWN_ID, "the beacon must echo MCP_SPAWN_ID so the host can attribute it");
  });
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** `address()` is `string | AddressInfo | null` — a pipe path or a not-yet-
 *  listening socket both type-check as the TCP shape under a cast, and would
 *  hand the broker a bogus BASE_URL that fails as "no beacon". */
function listeningPort(server: Server): number {
  const address: string | AddressInfo | null = server.address();
  if (address === null || typeof address === "string") throw new Error(`expected a TCP address, got ${JSON.stringify(address)}`);
  return address.port;
}

interface BeaconPayload {
  bootMs: number;
  initializeMs: number;
  kind: string;
  spawnId: string;
}

function isBeaconPayload(value: unknown): value is BeaconPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate: Record<string, unknown> = { ...value };
  return (
    typeof candidate.bootMs === "number" &&
    typeof candidate.initializeMs === "number" &&
    typeof candidate.kind === "string" &&
    typeof candidate.spawnId === "string"
  );
}
