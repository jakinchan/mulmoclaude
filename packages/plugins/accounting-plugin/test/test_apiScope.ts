// A card's api client stays on the project the card was opened for.
//
// The failure this pins is quiet and expensive: in a multi-root host a
// card opened against project A keeps its bookId, so once the host's
// active project moves to B, an unpinned client reads — and writes —
// B's book of the same id. Same numbers on screen, wrong company's
// books underneath.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createAccountingApi } from "../src/vue/api";
import { configureAccountingHost, type ApiResult } from "../src/vue/hostContext";
import { ACCOUNTING_PROJECT_FIELD } from "../src/shared";

const bodies: Record<string, unknown>[] = [];
let hostScope: string | null = null;

beforeEach(() => {
  bodies.length = 0;
  hostScope = null;
  configureAccountingHost({
    apiCall: <T>(_path: string, opts: { body?: unknown }): Promise<ApiResult<T>> => {
      bodies.push(opts.body as Record<string, unknown>);
      return Promise.resolve({ ok: true, data: { books: [] } as T });
    },
    subscribe: () => () => {},
    localeTag: () => "en",
    projectScope: () => hostScope,
  });
});

describe("client project scope", () => {
  it("a pinned client keeps its project when the host moves on", async () => {
    hostScope = "project-a";
    const api = createAccountingApi("project-a");
    hostScope = "project-b";
    await api.getBooks();
    assert.equal(bodies[0]?.[ACCOUNTING_PROJECT_FIELD], "project-a");
  });

  it("a client pinned to the default root never names a project", async () => {
    hostScope = "project-b";
    await createAccountingApi(null).getBooks();
    assert.equal(ACCOUNTING_PROJECT_FIELD in (bodies[0] ?? {}), false);
  });

  it("a single-root host's request body is unchanged", async () => {
    await createAccountingApi(null).getBooks();
    assert.deepEqual(bodies[0], { action: "getBooks" });
  });
});
