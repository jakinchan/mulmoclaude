// Pure helper split out of mcp-server.ts so active-tool resolution is
// unit-testable without booting the stdio JSON-RPC bridge (which reads
// process.argv, opens stdin, and calls back to the parent server at import).

/**
 * Map the active tool names to their definitions in `all`, dropping any name
 * that `all` does not carry as an OWN property.
 *
 * Own-property guarded on purpose: a name like `constructor` / `toString` /
 * `__proto__` would otherwise read an inherited `Object.prototype` member,
 * survive a `filter(Boolean)`, and ride into `tools/list` as a bogus tool
 * whose `.name` reads `"Object"`. The guard makes such a name resolve to a
 * miss (skipped), exactly like a name that was never registered.
 */
export function resolveActiveTools<T>(names: readonly string[], all: Record<string, T>): T[] {
  const resolved: T[] = [];
  for (const name of names) {
    if (!Object.hasOwn(all, name)) continue;
    // An own key whose value is absent counts as a miss too.
    const tool = all[name];
    if (tool !== undefined) resolved.push(tool);
  }
  return resolved;
}
