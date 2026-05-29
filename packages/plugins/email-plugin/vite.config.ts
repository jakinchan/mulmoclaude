import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

// Server-only plugin (v1): one entry, no Vue View yet. Mirrors
// the externals strategy from edgar-plugin / bookmarks-plugin —
// `gui-chat-protocol` and `zod` are bundled inline so the runtime
// loader can extract the published tarball into a cache dir
// without needing the user to `npm install` peer deps.
export default defineConfig({
  plugins: [
    dts({
      include: ["src/**/*.ts"],
      outDir: "dist",
      compilerOptions: { rootDir: "src" },
    }),
  ],
  build: {
    lib: {
      entry: { index: "src/index.ts" },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      // While this plugin is devOnly (#1542), the preset loader
      // resolves it via the yarn-workspace symlink and the imap /
      // smtp / mime-parsing libs are hoisted into the repo's
      // node_modules — leave them external so we don't pay the
      // ESM-bundling-CJS interop cost (mailparser → libmime →
      // iconv has CJS class-extends chains that explode when
      // inlined). When we publish via npm, the libs will need to
      // travel with the tarball — either as real `dependencies`
      // (npm install hoists them at the consumer) or as a future
      // bundled build once the CJS interop is properly solved.
      external: [/^node:/, "imapflow", "nodemailer", "mailparser"],
    },
    minify: false,
    sourcemap: true,
  },
});
