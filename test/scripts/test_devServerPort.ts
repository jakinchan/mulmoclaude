// Unit tests for the dev proxy's port resolution (#2650).
//
// The backend honours `PORT` while Vite's proxy targeted a literal `localhost:3001`,
// so `PORT=3100 yarn dev` moved only the server — and with a first instance still on
// 3001, the second browser silently rendered the FIRST instance's data. These pin the
// resolution order (shell over `.env` over default), the `.env` parsing, and the
// rejection of values that would otherwise become `http://localhost:NaN`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SERVER_PORT, parseEnvFilePort, parseServerPort, resolveServerPort, serverOrigins } from "../../scripts/lib/devServerPort.js";

describe("parseServerPort", () => {
  it("accepts a plain port number, with or without surrounding whitespace", () => {
    assert.equal(parseServerPort("3100"), 3100);
    assert.equal(parseServerPort("  3100  "), 3100);
  });

  it("accepts the boundary ports", () => {
    assert.equal(parseServerPort("1"), 1);
    assert.equal(parseServerPort("65535"), 65_535);
  });

  // Any of these would have become `http://localhost:NaN` — a target that fails per
  // request, far from the typo that caused it.
  for (const raw of ["0", "65536", "abc", "", "   ", "-1", "3100.5", "3100abc", "0x1f", undefined, null]) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      assert.equal(parseServerPort(raw), null);
    });
  }
});

describe("parseEnvFilePort", () => {
  it("reads a PORT assignment", () => {
    assert.equal(parseEnvFilePort("PORT=3100"), 3100);
  });

  it("tolerates whitespace and quotes", () => {
    assert.equal(parseEnvFilePort('  PORT = "3100" '), 3100);
    assert.equal(parseEnvFilePort("PORT='3100'"), 3100);
  });

  it("ignores a commented-out assignment", () => {
    assert.equal(parseEnvFilePort("# PORT=3100"), null);
    assert.equal(parseEnvFilePort("#PORT=3100\nOTHER=1"), null);
  });

  it("does not match a key that merely ends in PORT", () => {
    assert.equal(parseEnvFilePort("EXPORT=3100\nMY_PORT=3200"), null);
  });

  it("takes the LAST assignment, as dotenv does", () => {
    assert.equal(parseEnvFilePort("PORT=3100\nPORT=3200"), 3200);
  });

  it("finds PORT among other keys", () => {
    assert.equal(parseEnvFilePort("GEMINI_API_KEY=abc\nPORT=3100\nMULMOCLAUDE_WORKSPACE_PATH=/tmp/ws"), 3100);
  });

  it("returns null for an absent file or an unusable value", () => {
    assert.equal(parseEnvFilePort(undefined), null);
    assert.equal(parseEnvFilePort("OTHER=1"), null);
    assert.equal(parseEnvFilePort("PORT=nonsense"), null);
  });
});

describe("resolveServerPort", () => {
  it("defaults to the backend's own default when nothing is set", () => {
    assert.equal(resolveServerPort(), DEFAULT_SERVER_PORT);
    assert.equal(resolveServerPort({ processEnv: {}, envFileText: "" }), DEFAULT_SERVER_PORT);
  });

  it("takes PORT from the environment", () => {
    assert.equal(resolveServerPort({ processEnv: { PORT: "3100" } }), 3100);
  });

  it("falls back to .env when the shell has none — the split this bug was made of", () => {
    assert.equal(resolveServerPort({ processEnv: {}, envFileText: "PORT=3100" }), 3100);
  });

  // The server's loader lets an exported shell variable win over the file; the proxy
  // has to resolve the same way or the two halves point at different servers.
  it("lets the shell win over .env", () => {
    assert.equal(resolveServerPort({ processEnv: { PORT: "3100" }, envFileText: "PORT=3200" }), 3100);
  });

  it("treats an empty PORT as unset", () => {
    assert.equal(resolveServerPort({ processEnv: { PORT: "" }, envFileText: "PORT=3200" }), 3200);
  });

  it("reports an unusable PORT instead of swallowing it, and keeps looking", () => {
    const reported: string[] = [];
    const port = resolveServerPort({
      processEnv: { PORT: "nonsense" },
      envFileText: "PORT=3200",
      onInvalid: (source, raw) => reported.push(`${source}=${raw}`),
    });
    assert.deepEqual(reported, ["PORT=nonsense"]);
    assert.equal(port, 3200);
  });

  it("does not report when PORT is simply absent", () => {
    const reported: string[] = [];
    resolveServerPort({ processEnv: {}, onInvalid: (source, raw) => reported.push(`${source}=${raw}`) });
    assert.deepEqual(reported, []);
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
