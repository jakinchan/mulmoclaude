import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDevWatchIgnore } from './scripts/lib/devWatchIgnore'
import { resolveServerPort, serverOrigins } from './scripts/lib/devServerPort'
import { parseEnvFile } from './server/utils/launch-env.mjs'

// Token file path mirrors `WORKSPACE_PATHS.sessionToken` in
// server/workspace-paths.ts. Duplicated here (rather than imported)
// because Vite config runs outside the TS server tsconfig.
//
// Honors MULMOCLAUDE_WORKSPACE_PATH (via process.env or directly
// parsing .env file) so the dev token plugin reads the same workspace
// the server is using. Local patch 2026-05-30 to fix the unauthorized
// error when workspace is relocated.
function resolveWorkspacePath(): string {
  const fromProcess = process.env.MULMOCLAUDE_WORKSPACE_PATH
  if (fromProcess && fromProcess.length > 0) return fromProcess
  try {
    const envPath = path.join(process.cwd(), '.env')
    const content = fs.readFileSync(envPath, 'utf-8')
    const match = content.match(/^MULMOCLAUDE_WORKSPACE_PATH=(.+)$/m)
    if (match) return match[1].trim()
  } catch {
    /* .env not present, fall through to default */
  }
  return path.join(os.homedir(), 'mulmoclaude')
}
const TOKEN_FILE_PATH = path.join(resolveWorkspacePath(), '.session-token')

// Where the dev proxy sends `/api` and the pubsub socket. Read from the same
// place the backend reads its own port (#2650): a literal `localhost:3001` meant
// `PORT=3100 yarn dev` moved only the server, and with a first instance still on
// 3001 the second browser silently showed the FIRST instance's data.
//
// `.env` is consulted for the same reason `resolveWorkspacePath()` consults it —
// the server's loader populates `process.env` from that file, so a `PORT` set
// there and nowhere else must not split the two halves apart.
const SERVER_PORT = resolveServerPort({
  processEnv: process.env,
  // The launcher's parser — i.e. `dotenv.parse`, the same one the server's loader
  // uses. Reading the file by hand here would let the two disagree about inline
  // comments, an `export ` prefix or quoting, which is this bug one level down.
  envFileValues: parseEnvFile(path.join(process.cwd(), '.env')).parsed,
  onInvalid: (source, raw) => console.warn(`[vite] ignoring ${source}="${raw}" — not a port; proxying to the default instead`),
})
const { http: SERVER_ORIGIN, ws: SERVER_WS_ORIGIN } = serverOrigins(SERVER_PORT)
const TOKEN_PLACEHOLDER = '__MULMOCLAUDE_AUTH_TOKEN__'

// The workspace-is-the-Vite-root comparison below has to survive symlinked
// homes (macOS resolves `/tmp` and some `$HOME` layouts through `/private`) and
// NTFS junctions, so both sides go through realpath first. A workspace that
// doesn't exist yet (first boot) keeps its literal path.
function realpathOrSelf(candidate: string): string {
  try {
    return fs.realpathSync.native(candidate)
  } catch {
    return candidate
  }
}

// #2632: prune runtime writes and (on Windows) sandbox-mount mtime bumps from
// the dev watcher, both of which full-reload the page mid-agent-turn.
const devWatchIgnore = createDevWatchIgnore({
  projectRoot: realpathOrSelf(__dirname),
  workspacePath: realpathOrSelf(resolveWorkspacePath()),
  platform: process.platform,
  watchPackageDists: process.env.MULMOCLAUDE_DEV_WATCH_PACKAGES === '1',
})

// Dev-side half of the bearer-token injection (#272). The server
// writes the token to `TOKEN_FILE_PATH` at startup (mode 0600); this
// plugin reads that file on every index.html request and substitutes
// it into the `<meta name="mulmoclaude-auth" content="...">` tag.
//
// **Fallback**: if the file is missing (server not running, E2E with
// mocked API, `yarn dev:client` alone), we inject an empty string.
// Vue boot code reads an empty token as "no auth" and every real
// request 401s — that matches the dev ergonomics we want (no silent
// fake token). E2E tests never reach the real server (mocks), so they
// don't care about the header value.
function readDevToken(): string {
  // Env var takes precedence over the workspace file. This is the
  // escape hatch for (a) E2E tests that spawn `yarn dev:client`
  // without a running server (playwright.config.ts sets it), and
  // (b) future debugging / alternative dev workflows. Production
  // never reads env — Express is always the source of truth there.
  const fromEnv = process.env.MULMOCLAUDE_AUTH_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  try {
    return fs.readFileSync(TOKEN_FILE_PATH, 'utf-8').trim()
  } catch {
    return ''
  }
}

// True for an IPv4/IPv6 loopback peer. Node reports an IPv4 peer on a
// dual-stack socket as `::ffff:127.0.0.1`, so the mapped form is unwrapped
// before comparing — matching only the bare literals would classify a real
// loopback client as remote.
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const bare = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return bare === '::1' || bare === '127.0.0.1' || bare.startsWith('127.')
}

// Carries "did this request arrive on the loopback interface?" from the
// connect middleware (which can see the socket) down to
// `transformIndexHtml` (which cannot — `IndexHtmlTransformContext` has no
// `req`). AsyncLocalStorage rather than a module-level variable because
// concurrent requests would otherwise read each other's value.
const requestFromLoopback = new AsyncLocalStorage<boolean>()

// Every path this dev server forwards to Express. Kept in sync with
// `server.proxy` below — a prefix added there without being added here is
// reachable from the LAN whenever MULMOCLAUDE_DEV_LAN is set.
//
// `/ws` is the backend pub/sub socket. It needs BOTH guards below: the
// connect middleware never sees a WebSocket handshake (those arrive on the
// http server's `upgrade` event, not the request pipeline), so the prefix
// alone would not stop it.
const PROXIED_BACKEND_PREFIXES = ['/api', '/artifacts', '/ws'] as const

function startsWithProxiedPrefix(url: string | undefined): boolean {
  return PROXIED_BACKEND_PREFIXES.some((prefix) => url?.startsWith(prefix) ?? false)
}

function mulmoclaudeAuthTokenPlugin(): Plugin {
  return {
    name: 'mulmoclaude-auth-token',
    // **Dev only.** In production the built index.html keeps the
    // placeholder; Express substitutes it per-request when serving
    // the file (see `server/index.ts` prod static handler). If this
    // plugin ran at build time too, the placeholder would be baked
    // out to whatever value the builder happened to see — wrong for
    // every subsequent user.
    apply: 'serve',
    // Registered from the `configureServer` body (not a returned function)
    // so it runs BEFORE Vite's own html-serving middleware, and therefore
    // before `transformIndexHtml` reads the store.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const fromLoopback = isLoopbackAddress(req.socket.remoteAddress)
        // Backend surface stays loopback-only even when the dev server is
        // bound to every interface. These paths are PROXIED to Express, and
        // some of them (`/api/files/*`, the `/artifacts/*` static mounts)
        // are deliberately bearer-exempt because a browser `<img>` cannot
        // send an Authorization header — their only protection was that
        // Express binds to 127.0.0.1. The proxy defeats that: Express sees
        // the proxy's own loopback socket, not the real client. Refusing
        // here is the only layer that can still tell the two apart.
        if (!fromLoopback && startsWithProxiedPrefix(req.url)) {
          res.statusCode = 403
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'Forbidden: backend access is loopback-only' }))
          return
        }
        requestFromLoopback.run(fromLoopback, next)
      })

      // WebSocket handshakes never reach the middleware above — Node routes
      // them to the http server's `upgrade` event instead. Without this the
      // `/ws` proxy would still carry backend pub/sub to a LAN client even
      // though every HTTP path is refused.
      //
      // `prependListener` so this runs before the proxy's own upgrade
      // handler, and only backend prefixes are destroyed — Vite's HMR socket
      // is left alone, otherwise enabling LAN mode would break the very page
      // it is meant to serve.
      server.httpServer?.prependListener('upgrade', (req, socket) => {
        if (isLoopbackAddress(socket.remoteAddress)) return
        if (!startsWithProxiedPrefix(req.url)) return
        socket.destroy()
      })
    },
    transformIndexHtml(html) {
      // The session token is a bearer credential for the whole API, so it
      // is only ever handed to a caller on this machine. A non-loopback
      // requester gets the empty string, which the Vue boot code already
      // treats as "no auth" (every API call then 401s) — the same path as
      // a missing token file.
      //
      // This matters because `/api` is PROXIED to Express: without the
      // check, opting into `MULMOCLAUDE_DEV_LAN` would hand a full-API
      // credential to anyone who can load the page, and Express would see
      // every proxied call as loopback-sourced and trust it.
      const fromLoopback = requestFromLoopback.getStore() ?? false
      return html.replace(TOKEN_PLACEHOLDER, fromLoopback ? readDevToken() : '')
    },
  }
}

// Runtime-plugin importmap rewrite for production builds (#1043 C-2
// Phase E). The dev importmap maps `"vue"` → `/src/_runtime/vue.ts`,
// which Vite serves transformed and resolves to the host's Vue dep.
// In `vite build` that dev URL no longer exists — Vite emits a
// hashed asset for the runtime/vue chunk. This plugin (build-only)
// finds the hashed filename in the bundle and rewrites the
// importmap target so runtime-loaded plugins still share the host's
// Vue instance after `yarn build` and `npx mulmoclaude` distribution.
function runtimeImportmapBuildPlugin(): Plugin {
  // Each importmap entry maps `(dev URL → chunk name)`. The dev URL is
  // the static path the browser sees during `yarn dev`; the chunk
  // name matches the Rollup input key registered in
  // `build.rollupOptions.input` below. After build, the dev URL gets
  // rewritten to the hashed asset path.
  const ENTRIES: Array<{ devUrl: string; chunkName: string }> = [
    { devUrl: '/src/_runtime/vue.ts', chunkName: 'runtime-vue' },
    { devUrl: '/src/_runtime/protocol-vue.ts', chunkName: 'runtime-protocol-vue' },
  ]
  return {
    name: 'mulmoclaude-runtime-importmap',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle) return html
        let next = html
        for (const { devUrl, chunkName } of ENTRIES) {
          let runtimeFile: string | null = null
          for (const [fileName, chunk] of Object.entries(ctx.bundle)) {
            if (chunk.type === 'chunk' && chunk.name === chunkName) {
              runtimeFile = fileName
              break
            }
          }
          if (!runtimeFile) {
            // Surface explicitly so a future input rename (or a
            // tree-shake regression on the runtime entry) doesn't
            // silently leave the dev URL in the built importmap and
            // break runtime-loaded plugins in production with no
            // diagnostic. CodeRabbit review on PR #1124.
            console.warn(`[mulmoclaude] runtime importmap chunk not emitted: ${chunkName} (importmap entry "${devUrl}" left as dev URL)`)
            continue
          }
          // `replaceAll` (not `replace`) so both occurrences get
          // rewritten — the importmap target AND any comment that
          // documents the dev URL.
          next = next.replaceAll(devUrl, `/${runtimeFile}`)
        }
        return next
      },
    },
  }
}

export default defineConfig({
  plugins: [vue(), tailwindcss(), mulmoclaudeAuthTokenPlugin(), runtimeImportmapBuildPlugin()],
  build: {
    outDir: 'dist/client',
    rollupOptions: {
      // `index.html` is the SPA entry. `runtime-vue` is a side-entry
      // that emits a separate chunk for the runtime importmap target
      // (#1043 C-2 Phase E). Without it as an explicit input, Vite
      // would tree-shake `src/_runtime/vue.ts` to nothing because no
      // build-time `import` references it — the importmap is consumed
      // by the BROWSER, not by Vite's static analysis.
      input: {
        index: path.resolve(__dirname, 'index.html'),
        'runtime-vue': path.resolve(__dirname, 'src/_runtime/vue.ts'),
        // Same pattern as runtime-vue: the importmap consumer is the
        // browser, not Vite's static analysis, so without this entry
        // the chunk gets tree-shaken out of the build.
        'runtime-protocol-vue': path.resolve(__dirname, 'src/_runtime/protocol-vue.ts'),
      },
      // Force every named re-export from `src/_runtime/vue.ts` to be
      // preserved in the emitted chunk. Without `'strict'`, Rolldown
      // tree-shakes the `export * from "vue"` re-exports (no static
      // consumer in the build references them — the browser does,
      // via the runtime importmap), shrinking the chunk to a 46-byte
      // side-effect stub. A runtime-loaded plugin's
      // `import { createCommentVNode } from "vue"` then fails with
      // "does not provide an export named 'createCommentVNode'".
      // `'strict'` is the public-library mode and matches what we
      // want here: the entry's exports ARE the public surface for
      // browser-side consumers.
      preserveEntrySignatures: 'strict',
      // Targeted build-time warning suppressions. EVERY entry here
      // matches by code AND file/message so unrelated occurrences of
      // the same warning code still surface.
      //
      // 1. INEFFECTIVE_DYNAMIC_IMPORT — `PluginScopedRoot.vue` is
      //    dynamically imported from `src/tools/runtimeLoader.ts`
      //    ONLY so that `test/tools/test_runtimeLoader.ts` (which
      //    runs under tsx in Node with no Vue SFC compiler) can
      //    import the loader module without crashing on a top-level
      //    `.vue` import. Production code also references the
      //    component statically (App.vue / SettingsModal.vue /
      //    plugins/scope.ts), so the dynamic import legitimately
      //    doesn't chunk-split — that's the intended outcome.
      onwarn(warning, defaultHandler) {
        if (warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT' && warning.message.includes('PluginScopedRoot.vue')) {
          return
        }
        defaultHandler(warning)
      },
    },
  },
  server: {
    // Loopback by default. `host: true` (0.0.0.0) used to be
    // unconditional, which put the dev server on every interface — and
    // since `/api` is proxied to Express, that made a
    // deliberately-127.0.0.1-bound backend reachable from the LAN through
    // the proxy. Express saw those calls arriving from loopback, so the
    // "we only bind to 127.0.0.1, therefore remote traffic can't reach
    // us" assumption in `server/api/csrfGuard.ts` no longer held.
    //
    // Set MULMOCLAUDE_DEV_LAN=1 to bind every interface. Note that a LAN
    // client still receives an EMPTY auth token (see
    // `mulmoclaudeAuthTokenPlugin`), so opting in exposes the page, not
    // the API. Only do it on a network you trust.
    host: process.env.MULMOCLAUDE_DEV_LAN === '1' ? true : '127.0.0.1',
    watch: {
      ignored: [devWatchIgnore],
    },
    // Disable Vite's dev CORS middleware. The app itself is same-origin in dev
    // (the page and the proxied `/api` both live on :5173), so it needs no CORS
    // headers from Vite. The one cross-origin consumer is a custom collection
    // view: it renders in a sandboxed (opaque-origin) iframe whose fetch to
    // `/api/collections/:slug/view-data` is cross-origin and preflighted. With
    // Vite's CORS enabled, Vite answers that OPTIONS itself WITHOUT an
    // `Access-Control-Allow-Origin` (it rejects the "null" origin) and the
    // preflight fails before reaching the backend. Disabling it lets the
    // preflight (and the request) flow through the proxy to Express, which sets
    // the correct CORS headers (`viewDataCors` in
    // server/api/routes/collections.ts). Production has no Vite proxy — the
    // iframe hits Express directly — so this is dev-only.
    cors: false,
    proxy: {
      '/api': {
        target: SERVER_ORIGIN,
        changeOrigin: true
      },
      // Static-mount on the backend (server/index.ts: app.use('/artifacts/images', ...)).
      // Without this proxy, dev's Vite catch-all returns the SPA index.html instead.
      '/artifacts/images': {
        target: SERVER_ORIGIN,
        changeOrigin: true
      },
      // Static-mount on the backend (server/index.ts: app.use('/artifacts/svg', ...)).
      // Same reason as `/artifacts/images`: `<img src="/artifacts/svg/...">` would
      // otherwise hit Vite's SPA catch-all and receive index.html (HTTP 200, HTML
      // body), which the browser silently fails to render as an image.
      '/artifacts/svg': {
        target: SERVER_ORIGIN,
        changeOrigin: true
      },
      // Static-mount on the backend (server/index.ts: app.use('/artifacts/html', ...)).
      // Without this proxy, Vite's HTML transform injects `/@vite/client` and
      // `/src/main.ts` into the response, which the iframe (opaque origin) then
      // tries to load and the browser blocks via CORS. Forwarding to Express
      // returns the file untouched plus the CSP HTTP header.
      //
      // `xfwd: true` adds `X-Forwarded-Host` / `X-Forwarded-Proto` so Express
      // can recover the browser-visible origin (`localhost:5173`) when emitting
      // the CSP `img-src` directive. `changeOrigin: true` rewrites `Host` to
      // the upstream backend origin, so without xfwd the CSP would advertise
      // the wrong origin and Safari would block every `<img src="../images/...">`
      // request (Chrome happens to be lenient because images route through the
      // same proxy).
      '/artifacts/html': {
        target: SERVER_ORIGIN,
        changeOrigin: true,
        xfwd: true
      },
      '/ws': {
        target: SERVER_WS_ORIGIN,
        ws: true
      }
    }
  }
})
