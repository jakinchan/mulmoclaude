// Built-in plugin scope wrapper. Wraps a built-in plugin's View /
// Preview component in `<PluginScopedRoot>` so descendants can pull
// the same `BrowserPluginRuntime` (via `useRuntime()` from
// `gui-chat-protocol/vue`) that runtime-loaded plugins receive.
//
// Why: the host's runtime plugin loader already wraps runtime
// plugins (`src/tools/runtimeLoader.ts#wrapWithScopedRoot`). For
// built-in plugins to opt into the same `useRuntime()` API — incl.
// `runtime.endpoints` for multi-URL plugins (gui-chat-protocol
// 0.3.1+) — they need a similar wrapper. This file is that
// wrapper, used at plugin-registration time so each plugin's
// `viewComponent` / `previewComponent` carries the scope provider.
//
// Endpoints come from the host's runtime registry at SETUP time
// (not module load) — `pluginEndpoints(scope)` reads from the
// `installHostContext` registry which is wired in `src/main.ts`
// before `app.mount`. By the time a plugin's setup() runs the
// registry is populated.

import { defineComponent, h, markRaw, type Component } from "vue";
import PluginScopedRoot from "../components/PluginScopedRoot.vue";
import { pluginEndpoints } from "./api";

/** Wrap a built-in plugin's component (`viewComponent` /
 *  `previewComponent`) so its descendants can call `useRuntime()`.
 *  The wrapped component:
 *
 *   - looks up the plugin's endpoint group from the host's DI
 *     registry at setup time,
 *   - mounts `<PluginScopedRoot pkg-name=<scope> :endpoints>`,
 *   - forwards every prop / attr / slot through to the inner
 *     component verbatim.
 *
 *  Returns `undefined` when `inner` is `undefined` — matches the
 *  `getPlugin().viewComponent` / `previewComponent` shape (presence
 *  is optional).
 *
 *  @param scope    plugin scope name (matches the install registry
 *                  key, e.g. `"todos"`, `"wiki"`, `"mulmoScript"`).
 *  @param inner    the plugin's raw View / Preview component. */
export function wrapWithScope(scope: string, inner: Component): Component;
export function wrapWithScope(scope: string, inner: Component | undefined): Component | undefined;
export function wrapWithScope(scope: string, inner: Component | undefined): Component | undefined {
  if (!inner) return inner;
  // `markRaw` so reactive containers don't try to proxy this
  // component object — Vue warns + the proxy can interfere with
  // internal component identity tracking. Same pattern as
  // `runtimeLoader.ts#wrapWithScopedRoot`.
  return markRaw(
    defineComponent({
      name: `BuiltInPluginScope:${scope}`,
      inheritAttrs: false,
      setup(_props, { attrs, slots }) {
        const endpoints = pluginEndpoints<Record<string, unknown>>(scope);
        return () => h(PluginScopedRoot, { pkgName: scope, endpoints }, () => h(inner, attrs, slots));
      },
    }),
  );
}
