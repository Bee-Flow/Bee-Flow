import { execSync } from 'child_process'
import { cpSync, createReadStream, existsSync, readFileSync, statSync } from 'fs'
import path from 'path'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'
import { defineConfig, loadEnv } from 'vite'

// Resolve a version string for the running build. Precedence:
//   1. VITE_BUILD_SHA env var (set by CI — `${{ github.sha }}` from the workflow).
//   2. `git rev-parse --short HEAD` (local dev).
//   3. 'dev' (no git available, e.g. inside a shallow Docker tarball).
function resolveBuildSha(envSha) {
    if (envSha && envSha.length > 0) return envSha.slice(0, 7);
    try {
        return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
            .toString().trim();
    } catch (_) {
        return 'dev';
    }
}

/**
 * The code step's editor runtime (Monaco), served by this app instead of
 * cdn.jsdelivr.net. @monaco-editor/react fetches it from the CDN unless told
 * otherwise, which sent every author's IP address to a third party and left an
 * offline or firewalled self-host with no editor at all (only the plain-text
 * fallback, after an eight-second wait). The files are the same version
 * (`monaco-editor/min/vs`); the code step points the loader at
 * `<base>monaco/vs` (src/.../codeStep/monaco.tsx). Build: copied next to
 * dist/assets (outside the bundle budget on purpose: it is fetched only when a
 * code step's editor opens, exactly as the CDN copy was). Dev: served from
 * node_modules.
 */
const MONACO_VS = path.resolve(__dirname, 'node_modules/monaco-editor/min/vs')
const MONACO_TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.json': 'application/json' }
function monacoSelfHost() {
    let outDir = null
    return {
        name: 'beeflow-monaco-self-host',
        configResolved(config) { outDir = path.resolve(config.root, config.build.outDir) },
        configureServer(server) {
            server.middlewares.use(`${server.config.base}monaco/vs`, (req, res, next) => {
                const rel = decodeURIComponent(String(req.url || '').split('?')[0])
                const file = path.join(MONACO_VS, rel)
                if (!file.startsWith(MONACO_VS + path.sep) || !existsSync(file) || !statSync(file).isFile()) return next()
                res.setHeader('Content-Type', MONACO_TYPES[path.extname(file)] || 'application/octet-stream')
                createReadStream(file).pipe(res)
            })
        },
        closeBundle() {
            if (!outDir || !existsSync(MONACO_VS)) return
            cpSync(MONACO_VS, path.join(outDir, 'monaco', 'vs'), { recursive: true })
        },
    }
}

// https://vite.dev/config/
// The vendor chunk table. Lives at module scope so the manualChunks
// function below can consult it; the entries are unchanged from the
// object form they replace.
const VENDOR_CHUNKS = {
        // React core — changes almost never.
        // `react/jsx-runtime`, `scheduler` and
        // `use-sync-external-store` MUST be listed. Without them
        // Rollup puts them in whichever named chunk references
        // them first, and the entry then has to import that
        // chunk — and whatever it drags along — purely to get
        // the JSX factory. (Historically that chunk was
        // vendor-tiptap, which pulled in monaco and mermaid.
        // TipTap is gone; the pin is still load-bearing.)
        // `react-is` belongs here for the same reason as the three above, and
        // was found the same way: with it unpinned, Rollup placed it by usage,
        // it landed in vendor-charts, and vendor-react then carried
        // `import{h as ze}from"./vendor-charts-...js"` — so recharts (118 KB gz)
        // was preloaded on every marketing pageview to supply one predicate.
        'vendor-react': [
            'react', 'react-dom', 'react/jsx-runtime', 'scheduler',
            'use-sync-external-store', 'react-is',
        ],
        // Heavy visualisation libs
        // `@mermaid-js/parser` MUST be listed with mermaid. Its code already
        // lands in vendor-mermaid (a static dependency of mermaid), but the
        // parser loads each diagram grammar through `import()` of a module
        // that only re-exports from that code (`info-…mjs`, `treemap-…mjs`).
        // Left unpinned, those re-export modules form a chunk with no code
        // that imports vendor-mermaid, and Rollup merges such a chunk into
        // whichever small chunk has a matching set of importers. Measured: it
        // merged into the chunk of the Bee Flow icon SVG, which AuthedApp
        // imports, so every signed-in page load pulled vendor-mermaid (694 KB
        // gz) and through it vendor-dnd and vendor-charts (about 900 KB gz in
        // all) for the URL of one icon. Pinned here, the grammars resolve
        // inside vendor-mermaid and no such chunk exists.
        'vendor-mermaid': ['mermaid', '@mermaid-js/parser'],
        'vendor-monaco': ['@monaco-editor/react'],
        'vendor-vega': ['vega', 'vega-embed', 'vega-lite'],
        'vendor-katex': ['katex', 'rehype-katex', 'remark-math'],
        // No editor vendor chunk: the rich-text editor is
        // first-party (src/editor, "BeeEditor") and has no
        // third-party runtime dependency to split out. The
        // former vendor-tiptap / vendor-tiptap-extra chunks went
        // away with TipTap itself.
        // DnD primitives: only needed by builders / sortable lists.
        'vendor-dnd': [
            '@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities',
            '@xyflow/react', '@dagrejs/dagre',
        ],
        // React Grid Layout — used only by ComponentBuilder.
        'vendor-grid-layout': ['react-grid-layout'],
        'vendor-markdown': ['react-markdown', 'remark-gfm', 'highlight.js'],
        // Charts / misc
        'vendor-charts': ['recharts'],
        // 'vendor-misc' is on the first-load path: main.jsx needs the
        // query client unconditionally. It must contain ONLY things
        // worth paying for on first paint — which is why lucide-react
        // is deliberately NOT pinned here anymore. With AppIcon's
        // wildcard import gone (components/iconRegistry.js), Rollup
        // tree-shakes the registry's ~130 icons into the chunks that
        // use them, and the full barrel exists only as the lazy chunk
        // AppIcon fetches on a non-registry icon name. Pinning the
        // package again would weld all ~1,900 icons back into one
        // eagerly-loaded chunk — the exact 170 KB this change removed.
        'vendor-misc': ['@tanstack/react-query', 'uuid'],
};

export default defineConfig(({ mode }) => {
    // Load env file from parent directory
    const env = loadEnv(mode, path.resolve(__dirname, '..'), '')

    // Get ports from env or default
    const SERVER_PORT = env.SERVER_PORT || 3001
    const CLIENT_PORT = env.CLIENT_PORT || 5175

    // Version metadata — injected at build time as a JS constant.
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));
    const buildSha = resolveBuildSha(env.VITE_BUILD_SHA || process.env.VITE_BUILD_SHA);
    const buildDate = new Date().toISOString();

    // Bundle analyzer: run `npm run build:analyze` to open dist/stats.html.
    // The env-gated check keeps it out of normal builds — adding it
    // unconditionally would emit stats.html on every CI build and slow
    // production builds for no reason.
    const enableAnalyzer = env.VITE_BUNDLE_ANALYZE === '1' || process.env.VITE_BUNDLE_ANALYZE === '1';

    return {
        plugins: [
            react(),
            monacoSelfHost(),
            ...(enableAnalyzer ? [visualizer({
                filename: 'dist/stats.html',
                template: 'treemap',
                gzipSize: true,
                brotliSize: true,
                emitFile: false,
                open: false,
            })] : []),
        ],
        envDir: '..',
        resolve: {
            // '@/' resolves to 'src/'. Use sparingly during the refactor —
            // files adopt the alias as they are touched; we do not mass-rewrite
            // existing relative imports. Keep the alias in sync with the
            // 'paths' mapping in tsconfig.json.
            alias: {
                '@': path.resolve(__dirname, 'src'),
                // Isomorphic modules mirrored from the server (e.g. the
                // expression engine). Kept IN-TREE (src/shared) so they're in
                // the agent-hub Docker build context; a byte-identical copy
                // lives at server/shared and a sync test pins them equal.
                '@shared': path.resolve(__dirname, 'src/shared'),
            },
        },
        define: {
            // Available app-wide as import-meta constants. Rollup inlines them,
            // so there's no runtime cost and no risk of "undefined".
            __APP_VERSION__: JSON.stringify(pkg.version),
            __APP_BUILD_SHA__: JSON.stringify(buildSha),
            __APP_BUILD_DATE__: JSON.stringify(buildDate),
        },
        build: {
            target: 'esnext',
            // 'hidden': emit .map files but omit the //# sourceMappingURL= comment,
            // so browsers don't auto-fetch them. We strip the .map files from the
            // served Docker image (nginx 404 + Dockerfile delete) and keep them
            // only as CI artifacts for decoding minified production stack traces.
            sourcemap: 'hidden',
            rollupOptions: {
                output: {
                    /* HISTORY, because this looks like something worth
                       "simplifying" and is not. A hand-written function form was
                       tried once — classify each package by matching its resolved
                       path — and it measured WORSE: first load went 817 KB → 1.3
                       MB gzipped, because every package it left unassigned got
                       placed by usage, and the shared d3/react plumbing then
                       dragged the mermaid chunk onto the entry path. Numbers, not
                       theory. Do not change this without measuring the first-load
                       set out of dist/index.html before and after.

                       What follows is NOT that function. It is a thin wrapper
                       that consults VENDOR_CHUNKS — the same table, unchanged —
                       and returns undefined for everything else, so Rollup's own
                       placement is exactly as it was, with one addition.

                       THE ADDITION: Vite's `__vitePreload` helper is a VIRTUAL
                       module (`\0vite/preload-helper`), so the object form could
                       not name it and Rollup was free to park it in whichever
                       manual chunk referenced it first. It picked vendor-mermaid.
                       The measured consequence: the entry chunk carried
                       `import{d1 as K}from"./vendor-mermaid-...js"` — seven
                       characters of bindings — and every marketing pageview
                       therefore downloaded 187 KB gzipped of Mermaid to obtain a
                       one-kilobyte function. vendor-dnd (69 KB) and vendor-monaco
                       arrived on the entry path the same way.

                       It gets a chunk of its OWN rather than being folded into
                       vendor-react. Folding it in was tried and measured worse:
                       it made vendor-react a chunk that other vendor chunks
                       import, and Rollup answered by pulling vendor-charts
                       (118 KB gz) onto the entry path. A dedicated ~1 KB chunk
                       has no such gravity — it imports nothing, so nothing can
                       ride along with it. Measure before/after out of
                       dist/index.html when touching this. */
                    manualChunks(id) {
                        const path = id.replace(/\\/g, '/');
                        /* Generated runtime shims, not packages. Both are virtual
                           modules a few lines long, both are imported from all
                           over, and both were being parked inside whichever big
                           chunk happened to reference them first — which is how a
                           marketing page ended up preloading Mermaid (187 KB) for
                           `__vitePreload`, and then recharts (117 KB) for
                           `getDefaultExportFromCjs`, an eight-line CommonJS
                           interop shim. Collect them in one ~1 KB chunk that
                           imports nothing, so nothing can ride along with them. */
                        if (path.includes('vite/preload-helper')) return 'vendor-runtime-helpers';
                        if (path.includes('commonjsHelpers')) return 'vendor-runtime-helpers';
                        if (!path.includes('node_modules')) return undefined;
                        for (const [chunk, pkgs] of Object.entries(VENDOR_CHUNKS)) {
                            // Trailing slash so `react` cannot swallow `react-dom`.
                            if (pkgs.some(p => path.includes(`node_modules/${p}/`))) return chunk;
                        }
                        return undefined;
                    },
                },
            },
        },
        test: {
            globals: true,
            // jsdom is the DEFAULT, not the universal answer: ~187 pure-logic
            // suites opt out per file with `// @vitest-environment node`
            // (measured: 66s -> 22s wall on those 181 files; jsdom
            // construction alone is ~102s of CPU across them). Component
            // suites stay here. Do not try to express the split as a glob —
            // it does not follow the tree (.test.js alone splits 173 DOM-free
            // / 234 DOM-requiring across 15+ directories) — and
            // environmentMatchGlobs no longer exists in vitest 4.
            environment: 'jsdom',
            setupFiles: ['./src/test/setup.js'],
            css: false,
            // 'forks' (vitest's default) launches worker processes whose IPC
            // paths get URL-encoded; with a workspace path that contains
            // spaces (e.g. "VS Projects/Bee Flow - AI") the encoded path
            // never resolves and every worker times out. 'threads' avoids
            // that handshake entirely.
            pool: 'threads',
            // The default 5s is a timeout for a HANG, and these are not hangs:
            // several suites mount a whole editor (canvas + ribbon + inspector
            // + autosave), which alone takes a couple of seconds and rather
            // more when every worker in a 400-file run is busy. At 5s the full
            // suite failed a different two or three files each time — all of
            // them green on their own — which is a suite that reports noise
            // instead of signal. 20s still fails a real hang fast.
            testTimeout: 20_000,
            // The EN i18n catalogue (src/i18n/en-defaults.js, 2.0 MB, 15,721
            // keys) is loaded by src/test/setup.js in EVERY test file. With
            // pool:'threads' and the default isolate:true, vitest spawns a
            // fresh worker THREAD per file — new module graph, nothing cached
            // across files — so vite-node ships 2 MB of transformed source
            // over RPC and re-wraps it in an AsyncFunction ~1,183 times.
            // Measured on a 15-file sample: 154 ms -> 74 ms per file for the
            // ensureI18nDefaults() await. Marked external, node imports the
            // real file natively: same module, same 15,721 keys, nothing
            // mocked, setup.js unchanged, production build unaffected (this
            // is test-only config).
            //
            // This holds ONLY while en-defaults.js needs no transform: no
            // imports, no JSX, no import.meta, no '@' alias, no __APP_*
            // define — one `export default` over an object literal.
            // src/i18n/enDefaultsExternal.test.js pins both halves.
            server: { deps: { external: [/src\/i18n\/en-defaults/] } },
            coverage: {
                provider: 'v8',
                reporter: ['text', 'html', 'json-summary'],
                include: ['src/**/*.{js,jsx,ts,tsx}'],
                exclude: [
                    'src/test/**',
                    'src/**/*.config.{js,ts}',
                ],
            },
        },
        server: {
            // Bind IPv4 loopback explicitly. Left unset, Vite defaults to
            // 'localhost' and Node may resolve that to ::1 ONLY — the dev
            // server then refuses every browser that picks IPv4 for
            // localhost, which is the common case on Windows. 127.0.0.1 also
            // matches how the stack publishes the API (127.0.0.1:3001), so
            // dev server and backend agree on one address family.
            host: '127.0.0.1',
            port: parseInt(CLIENT_PORT),
            // Fail fast if CLIENT_PORT is already taken instead of silently
            // drifting to 5277/5278 — those break because the backend's
            // CORS_ORIGIN only trusts the configured client port.
            strictPort: true,
            // Allow reading the repo-root shared/ dir (the isomorphic
            // expression engine) from the agent-hub dev server.
            fs: { allow: ['..'] },
            proxy: {
                '/agents': {
                    target: `http://127.0.0.1:${SERVER_PORT}`,
                    changeOrigin: true
                },
                '/auth': {
                    target: `http://127.0.0.1:${SERVER_PORT}`,
                    changeOrigin: true
                },
                '/components': {
                    target: `http://127.0.0.1:${SERVER_PORT}`,
                    changeOrigin: true
                },
                '/test-component': {
                    target: `http://127.0.0.1:${SERVER_PORT}`,
                    changeOrigin: true
                },
                '/ai': {
                    target: `http://127.0.0.1:${SERVER_PORT}`,
                    changeOrigin: true
                },
                '/api': {
                    target: `http://127.0.0.1:${SERVER_PORT}`,
                    changeOrigin: true
                }
            }
        }
    }
})

