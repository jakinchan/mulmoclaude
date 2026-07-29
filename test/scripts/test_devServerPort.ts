// Unit tests for the dev proxy's port resolution (#2650).
//
// The backend honours `PORT` while Vite's proxy targeted a literal `localhost:3001`,
// so `PORT=3100 yarn dev` moved only the server — and with a first instance still on
// 3001, the second browser silently rendered the FIRST instance's data. These pin the
// resolution order (shell over `.env` over default) and the rejection of values that
// would otherwise become `http://localhost:NaN`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SERVER_PORT, parseServerPort, resolveServerPort, serverOrigins } from "../../scripts/lib/devServerPort.js";
// The launcher's parser is the server's parser; the resolver is fed its output, so
// the pipeline below is exercised with the real thing rather than a stand-in.
import { parseEnvFile } from "../../server/utils/launch-env.mjs";

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

// `.env` is parsed by the launcher's `parseEnvFile` (dotenv), not by this module.
// These pin the pipeline end to end, because a hand-rolled parser here was the
// divergence risk: dotenv strips inline comments, honours `export `, and unquotes —
// get any of those wrong and the server reads 3100 while the proxy reads 3001, which
// is this very bug one level down (observed during review, not flagged by a bot).
const portFromEnvText = (text: string): number => {
  const { parsed } = parseEnvFile("(memory)", { readFileSync: () => text });
  return resolveServerPort({ processEnv: {}, envFileValues: parsed });
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
    assert.equal(resolveServerPort({ processEnv: {}, envFileValues: parsed }), DEFAULT_SERVER_PORT);
  });
});

describe("resolveServerPort", () => {
  it("defaults to the backend's own default when nothing is set", () => {
    assert.equal(resolveServerPort(), DEFAULT_SERVER_PORT);
    assert.equal(resolveServerPort({ processEnv: {}, envFileValues: {} }), DEFAULT_SERVER_PORT);
  });

  it("takes PORT from the environment", () => {
    assert.equal(resolveServerPort({ processEnv: { PORT: "3100" } }), 3100);
  });

  it("falls back to .env when the shell has none — the split this bug was made of", () => {
    assert.equal(resolveServerPort({ processEnv: {}, envFileValues: { PORT: "3100" } }), 3100);
  });

  // The server's loader lets an exported shell variable win over the file; the proxy
  // has to resolve the same way or the two halves point at different servers.
  it("lets the shell win over .env", () => {
    assert.equal(resolveServerPort({ processEnv: { PORT: "3100" }, envFileValues: { PORT: "3200" } }), 3100);
  });

  it("treats an empty PORT as unset", () => {
    assert.equal(resolveServerPort({ processEnv: { PORT: "" }, envFileValues: { PORT: "3200" } }), 3200);
  });

  it("reports an unusable PORT instead of swallowing it, and keeps looking", () => {
    const reported: string[] = [];
    const port = resolveServerPort({
      processEnv: { PORT: "nonsense" },
      envFileValues: { PORT: "3200" },
      onInvalid: (source, raw) => reported.push(`${source}=${raw}`),
    });
    assert.deepEqual(reported, ["PORT=nonsense"]);
    assert.equal(port, 3200);
  });

  it("reports an unusable .env value too, then falls back to the default", () => {
    const reported: string[] = [];
    const port = resolveServerPort({
      processEnv: {},
      envFileValues: { PORT: "70000" },
      onInvalid: (source, raw) => reported.push(`${source}=${raw}`),
    });
    assert.deepEqual(reported, [".env PORT=70000"]);
    assert.equal(port, DEFAULT_SERVER_PORT);
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
