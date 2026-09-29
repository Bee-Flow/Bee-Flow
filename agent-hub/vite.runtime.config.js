import { readFileSync } from 'fs'
import path from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Headless App Studio runtime — a LIBRARY build, not another app build.
 *
 * `npm run build:runtime` emits dist-runtime/app-runtime.{mjs,css}: the App
 * Studio renderer (src/appRuntimeHeadless.jsx) as ONE self-contained ESM file
 * plus its compiled CSS. The consumer is server/services/appStudioRender.js,
 * which serves both files into a Playwright page that has NO NETWORK — hence
 * no externals, no CDN, no import map: react, recharts, lucide-react,
 * react-query, the shared expr engine all ride inside the bundle.
 *
 * inlineDynamicImports is load-bearing: AppIcon lazy-imports the full
 * lucide-react barrel for non-registry icon names, and a second chunk could
 * never be fetched in that page. Inlining folds it into the single file.
 *
 * The CSS side imports src/index.css (via the entry), so the emitted
 * stylesheet carries the platform tokens (--bg-primary/--text-primary/…) and
 * the same Tailwind utilities the real app compiles — an unstyled render
 * would defeat the whole point of judging layout.
 *
 * generate-module-shims.mjs (the app build's prebuild step) is NOT needed
 * here: the shims + import map serve externally-built marketplace modules in
 * index.html, and a library build has neither.
 */
export default defineConfig(() => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));

    return {
        plugins: [react()],
        // No public/ passthrough: the app's static assets (logos, fonts,
        // module shims) belong to the SPA build. The contract here is exactly
        // two files; anything else in dist-runtime is a bug.
        publicDir: false,
        resolve: {
            // Keep in lockstep with vite.config.js — the bundled sources use both.
            alias: {
                '@': path.resolve(__dirname, 'src'),
                '@shared': path.resolve(__dirname, 'src/shared'),
            },
        },
        define: {
            // Vite LIBRARY builds leave `process.env.NODE_ENV` verbatim (the
            // consumer is assumed to be a bundler that defines it) — but this
            // bundle's consumer is a bare browser page with no `process`, and
            // React's ESM entry reads it at module scope, so an undefined
            // process kills mount() before it starts. Pin it to production.
            'process.env.NODE_ENV': JSON.stringify('production'),
            // Same import-meta constants the app build injects; any bundled
            // module referencing them must not blow up the lib build.
            __APP_VERSION__: JSON.stringify(pkg.version),
            __APP_BUILD_SHA__: JSON.stringify('headless'),
            __APP_BUILD_DATE__: JSON.stringify(new Date().toISOString()),
        },
        build: {
            outDir: 'dist-runtime',
            emptyOutDir: true,
            target: 'esnext',
            sourcemap: false,
            // One stylesheet next to the module — the render service serves
            // exactly two files.
            cssCodeSplit: false,
            lib: {
                entry: path.resolve(__dirname, 'src/appRuntimeHeadless.jsx'),
                formats: ['es'],
                fileName: () => 'app-runtime.mjs',
                cssFileName: 'app-runtime',
            },
            rollupOptions: {
                output: { inlineDynamicImports: true },
            },
        },
    };
});
