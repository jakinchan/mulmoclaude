// Unit tests for the dev proxy's port resolution (#2650).
//
// The backend honours `PORT` while Vite's proxy targeted a literal `localhost:3001`,
// so `PORT=3100 yarn dev` moved only the server — and with a first instance still on
// 3001, the second browser silently rendered the FIRST instance's data.
//
// The rule under test is therefore an EQUIVALENCE, not a validator: for any value,
// the proxy must land on the port the backend binds. So the table below asserts
// against `env.port`'s own coercion (`asInt` + `PORT_RANGE`) rather than against a
// second opinion written here — a stricter parser was the finding Codex raised on
// iter-1, and this is what makes a future divergence fail loudly.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertProxyablePort,
  DEFAULT_SERVER_PORT,
  describeRejection,
  parseServerPort,
  resolveServerPort,
  serverOrigins,
} from "../../scripts/lib/devServerPort.js";
// The backend's own coercion and range, and the launcher's `.env` parser — the two
// authorities this module borrows from instead of reimplementing.
import { asInt, PORT_RANGE } from "../../server/utils/envCoerce.js";
import { parseEnvFile } from "../../server/utils/launch-env.mjs";

const serverWouldBind = (raw: string | undefined) => asInt(raw, DEFAULT_SERVER_PORT, PORT_RANGE);

describe("parseServerPort agrees with the port the backend would bind", () => {
  // Every form `Number()` accepts, which is what the backend uses. A parser built on
  // `/^\d+$/` rejects the last four and silently proxies to the default instead.
  for (const raw of ["3100", " 3100 ", "+3100", "3100.0", "0x1f", "1e3", "65535", "1"]) {
    it(`resolves ${JSON.stringify(raw)} to the same port as the server`, () => {
      const { port } = parseServerPort(raw);
      assert.equal(port, serverWouldBind(raw), `proxy and backend must agree on ${raw}`);
    });
  }

  // Values the backend itself ignores: it falls back to 3001, and so must the proxy.
  for (const raw of ["", "abc", "3100.5", "-1", "65536", "3100abc", undefined, null]) {
    it(`treats ${JSON.stringify(raw)} as unusable, exactly as the server does`, () => {
      const { port, reason } = parseServerPort(raw);
      assert.equal(port, null);
      assert.equal(reason, "ignored-by-server");
      assert.equal(serverWouldBind(raw ?? undefined), DEFAULT_SERVER_PORT);
    });
  }

  // `Number("   ")` is 0, so a whitespace-only PORT makes the BACKEND take an
  // ephemeral port. Surprising, and worth pinning: the proxy must refuse it for the
  // ephemeral reason, not report it as junk the server ignored.
  it("treats a whitespace-only PORT the way the server does — as 0, i.e. ephemeral", () => {
    const { port, reason } = parseServerPort("   ");
    assert.equal(port, null);
    assert.equal(reason, "ephemeral");
    assert.equal(serverWouldBind("   "), 0);
  });

  // The one place the two CANNOT agree, so it is refused by name rather than
  // silently mapped to 3001: the backend accepts 0 and lets the OS pick, and no
  // value computed at Vite-config time can know which port that turned out to be.
  it("refuses PORT=0 as ephemeral rather than pretending it is the default", () => {
    const { port, reason } = parseServerPort("0");
    assert.equal(port, null);
    assert.equal(reason, "ephemeral");
    assert.equal(serverWouldBind("0"), 0, "the backend does accept 0 — that is why this is a named refusal");
    assert.match(describeRejection("ephemeral"), /ephemeral/);
  });
});

// `.env` is parsed by the launcher's `parseEnvFile` (dotenv), not by this module.
// These pin the pipeline end to end, because a hand-rolled parser here was the
// divergence risk: dotenv strips inline comments, honours `export `, and unquotes —
// get any of those wrong and the server reads 3100 while the proxy reads 3001, which
// is this very bug one level down (observed during review, not flagged by a bot).
const portFromEnvText = (text: string): number => {
  const { parsed } = parseEnvFile("(memory)", { readFileSync: () => text });
  return resolveServerPort({ processEnv: {}, envFileValues: parsed }).port;
};

describe(".env values, parsed the way the server parses them", () => {
  it("reads a plain assignment", () => {
    assert.equal(portFromEnvText("PORT=3100"), 3100);
  });

  it("survives an inline comment — the case a hand-rolled parser gets wrong", () => {
    assert.equal(portFromEnvText("PORT=3100 # scratch instance"), 3100);
  });

  it("honours an `export ` prefix", () => {
    assert.equal(portFromEnvText("export PORT=3100"), 3100);
  });

  it("unquotes", () => {
    assert.equal(portFromEnvText('PORT="3100"'), 3100);
    assert.equal(portFromEnvText("PORT='3100'"), 3100);
  });

  it("ignores a commented-out assignment", () => {
    assert.equal(portFromEnvText("# PORT=3100"), DEFAULT_SERVER_PORT);
  });

  it("does not match a key that merely ends in PORT", () => {
    assert.equal(portFromEnvText("MY_PORT=3200"), DEFAULT_SERVER_PORT);
  });

  it("takes the last assignment", () => {
    assert.equal(portFromEnvText("PORT=3100\nPORT=3200"), 3200);
  });

  it("finds PORT among other keys", () => {
    assert.equal(portFromEnvText("GEMINI_API_KEY=abc\nPORT=3100\nMULMOCLAUDE_WORKSPACE_PATH=/tmp/ws"), 3100);
  });

  it("falls back when the file has no PORT, or none that is usable", () => {
    assert.equal(portFromEnvText("OTHER=1"), DEFAULT_SERVER_PORT);
    assert.equal(portFromEnvText("PORT=nonsense"), DEFAULT_SERVER_PORT);
  });

  it("treats an unreadable file as no file", () => {
    const { parsed } = parseEnvFile("/definitely/not/here/.env");
    assert.equal(resolveServerPort({ processEnv: {}, envFileValues: parsed }).port, DEFAULT_SERVER_PORT);
  });
});

describe("resolveServerPort", () => {
  const portOf = (sources: Parameters<typeof resolveServerPort>[0]) => resolveServerPort(sources).port;

  it("defaults to the backend's own default when nothing is set", () => {
    assert.equal(resolveServerPort().port, DEFAULT_SERVER_PORT);
    assert.deepEqual(resolveServerPort({ processEnv: {}, envFileValues: {} }), { port: DEFAULT_SERVER_PORT, problems: [] });
  });

  it("takes PORT from the environment", () => {
    assert.equal(portOf({ processEnv: { PORT: "3100" } }), 3100);
  });

  it("falls back to .env when the shell has none — the split this bug was made of", () => {
    assert.equal(portOf({ processEnv: {}, envFileValues: { PORT: "3100" } }), 3100);
  });

  // The server's loader lets an exported shell variable win over the file; the proxy
  // has to resolve the same way or the two halves point at different servers.
  it("lets the shell win over .env", () => {
    assert.equal(portOf({ processEnv: { PORT: "3100" }, envFileValues: { PORT: "3200" } }), 3100);
  });

  it("treats an empty PORT as unset, and says nothing about it", () => {
    const resolution = resolveServerPort({ processEnv: { PORT: "" }, envFileValues: { PORT: "3200" } });
    assert.equal(resolution.port, 3200);
    assert.deepEqual(resolution.problems, []);
  });

  it("reports an unusable PORT instead of swallowing it, and keeps looking", () => {
    const resolution = resolveServerPort({ processEnv: { PORT: "nonsense" }, envFileValues: { PORT: "3200" } });
    assert.deepEqual(resolution.problems, [{ source: "PORT", raw: "nonsense", reason: "ignored-by-server" }]);
    assert.equal(resolution.port, 3200);
  });

  // Was silent before: `raw.trim()` gated the report, so a whitespace-only value —
  // which the backend coerces to 0 — was refused with nothing said (Codex / CodeRabbit, #2653).
  it("reports a whitespace-only PORT rather than refusing it in silence", () => {
    const resolution = resolveServerPort({ processEnv: { PORT: "   " } });
    assert.deepEqual(resolution.problems, [{ source: "PORT", raw: "   ", reason: "ephemeral" }]);
  });

  it("reports an unusable .env value too, then falls back to the default", () => {
    const resolution = resolveServerPort({ processEnv: {}, envFileValues: { PORT: "70000" } });
    assert.deepEqual(resolution.problems, [{ source: ".env PORT", raw: "70000", reason: "ignored-by-server" }]);
    assert.equal(resolution.port, DEFAULT_SERVER_PORT);
  });
});

// A warning was not enough for `PORT=0`: the proxy fell through to another source
// (or `:3001`), the page loaded, and the client talked to whatever else was
// listening there — the silent mis-wiring this module exists to prevent. The dev
// server has to refuse to start (Codex, #2653).
describe("assertProxyablePort", () => {
  it("passes when every source was usable", () => {
    assert.doesNotThrow(() => assertProxyablePort(resolveServerPort({ processEnv: { PORT: "3100" } })));
    assert.doesNotThrow(() => assertProxyablePort(resolveServerPort({ processEnv: {} })));
  });

  it("passes when the only problem is a value the server itself ignores", () => {
    assert.doesNotThrow(() => assertProxyablePort(resolveServerPort({ processEnv: { PORT: "nonsense" } })));
  });

  it("throws for PORT=0, naming the port and what to do", () => {
    assert.throws(() => assertProxyablePort(resolveServerPort({ processEnv: { PORT: "0" } })), /OS-assigned port.*PORT=3100/s);
  });

  it("throws for a whitespace-only PORT, which coerces to 0", () => {
    assert.throws(() => assertProxyablePort(resolveServerPort({ processEnv: { PORT: "   " } })), /OS-assigned port/);
  });

  // A later valid source does NOT rescue it: the BACKEND uses the shell value and
  // takes an ephemeral port, so proxying to the `.env` port is still the wrong server.
  it("throws even when a later source would have given a usable port", () => {
    const resolution = resolveServerPort({ processEnv: { PORT: "0" }, envFileValues: { PORT: "3200" } });
    assert.equal(resolution.port, 3200);
    assert.throws(() => assertProxyablePort(resolution), /OS-assigned port/);
  });
});

describe("serverOrigins", () => {
  it("builds both origins from one port, so the proxy entries cannot drift", () => {
    assert.deepEqual(serverOrigins(3100), { http: "http://localhost:3100", ws: "ws://localhost:3100" });
  });

  it("keeps the default shape unchanged", () => {
    assert.deepEqual(serverOrigins(DEFAULT_SERVER_PORT), { http: "http://localhost:3001", ws: "ws://localhost:3001" });
  });
});
