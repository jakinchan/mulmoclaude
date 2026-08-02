// Dispatch registry for BUILT-IN plugins (task #6). Runtime-loaded
// plugins answer `POST /api/plugins/runtime/:pkg/dispatch` out of the
// runtime registry (see runtime-registry.ts). Built-in plugins — the
// ones bundled by Vite and wrapped with `wrapWithScope` — get the same
// `useRuntime().dispatch({ kind })` channel by registering a handler
// here keyed by their scope name (e.g. "markdown"). The dispatch route
// falls back to this registry when a name isn't a runtime plugin.
//
// Built-ins use this (rather than the runtime registry) because they
// need HOST backends — Puppeteer, Gemini, the document store — injected
// via gui-chat-protocol's `ToolContext.app`, which the generic runtime
// path (scoped files/fetch only) doesn't carry.

import { isObj, isRecord } from "../utils/types.js";

export type BuiltinDispatchHandler = (args: Record<string, unknown>) => Promise<unknown>;

const registry = new Map<string, BuiltinDispatchHandler>();

/** Render a rejected payload's `kind` for an error message, without
 *  dereferencing it.
 *
 *  A handler reaches this only after its guard said no, so the value is by
 *  definition malformed — and `payload.kind` on a `null` or a primitive throws
 *  a TypeError, replacing the diagnostic the caller was about to get with a
 *  crash. A rejection path that throws is not a rejection path.
 *
 *  The declared parameter is `Record<string, unknown>` and the HTTP route
 *  already coerces (`isRecord(req.body) ? req.body : {}`), so this is
 *  belt-and-braces for a direct caller — a test, or another host wiring the
 *  registry up itself. */
export function describeKind(payload: unknown): string {
  if (!isObj(payload)) return JSON.stringify(payload) ?? String(payload);
  return JSON.stringify(isRecord(payload) ? payload.kind : undefined) ?? "undefined";
}

/** Register a built-in plugin's dispatch handler under its scope name.
 *  Last registration wins (modules are imported once at boot). */
export function registerBuiltinDispatch(scope: string, handler: BuiltinDispatchHandler): void {
  registry.set(scope, handler);
}

/** Look up a built-in dispatch handler. Returns undefined when the
 *  name belongs to a runtime plugin (or nothing at all). */
export function getBuiltinDispatch(scope: string): BuiltinDispatchHandler | undefined {
  return registry.get(scope);
}
