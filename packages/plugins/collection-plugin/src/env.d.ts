declare module "*.css";

// SFC shim, matching the other plugins' `shims-vue.d.ts`. `vue-tsc` reads
// `.vue` natively so `yarn typecheck` passed without this, but eslint's TS
// program does not — every `.vue` import resolved to an error type, and the
// components built from them tripped `no-unsafe-assignment` instead.
declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<object, object, unknown>;
  export default component;
}
