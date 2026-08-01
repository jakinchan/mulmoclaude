// Express hands `req.body` to handlers as `any` — whatever `express.json()`
// parsed, which for a caller-controlled request is any JSON value at all
// (array, string, number, null). Route handlers that read named fields off
// it were writing `req.body as { field?: unknown }`, which asserts a shape
// nothing checked.

import { isRecord } from "./types.js";

/** Narrow a parsed request body to a plain object before reading fields off
 *  it. Anything that is not a plain object — an array, a bare string, null,
 *  a missing body — reads as empty, so every field lookup yields `undefined`
 *  and the handler's own required-field check produces the 400. */
export const requestBodyRecord = (body: unknown): Record<string, unknown> => (isRecord(body) ? body : {});
