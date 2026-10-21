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
/**
 * src/index.css no longer carries the Tailwind utilities layer nor the app's own
 * rules and alternate themes (the SPA loads them as further stylesheets,
 * src/tailwind-utilities.css, themes.css and app.css, so marketing pages do not
 * block on them). This bundle has ONE stylesheet and renders app screens, so it
 * needs all of them: add their imports to every module that imports index.css (utilities before it, being layered; themes and app after it, in source order).
 */
function utilitiesWithIndexCss() {
    return {
        name: 'beeflow-runtime-utilities',
        enforce: 'pre',
        transform(code, id) {
            if (!/\.(jsx?|tsx?)$/.test(id) || id.includes('node_modules')) return null;
            // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- build-time transform over our own source; negated character classes only: linear
            if (!/import\s+['"][^'"]*\/index\.css['"]|import\s+['"]\.\/index\.css['"]/.test(code)) return null;
            return { code: `import '@/tailwind-utilities.css';\n${code}\nimport '@/themes.css';\nimport '@/app.css';\n`, map: null };
        },
    };
}

/**
 * pdf_compare's pdf.js engine (pdfEngine.ts) is swapped for a stub that throws:
 * this page has no network and no worker, and pdf.js would add ~1 MB to a file
 * served on every render. The component shows a placeholder on that error.
 */
function stubPdfEngine() {
    return {
        name: 'beeflow-runtime-stub-pdf-engine',
        enforce: 'pre',
        resolveId(source, importer) {
            if (!/\/pdfEngine$/.test(source) || !importer) return null;
            return path.resolve(path.dirname(importer), 'pdfEngine.stub.ts');
        },
    };
}

export default defineConfig(() => {
    const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf8'));

    return {
        plugins: [react(), utilitiesWithIndexCss(), stubPdfEngine()],
        // No public/ passthrough: the app's static assets (logos, fonts,
        // module shims) belong to the SPA build. The contract here is exactly
        // two files; anything else in dist-runtime is a bug.
        publicDir: false,
        resolve: {
            // Keep in lockstep with vite.config.js — the bundled sources use both.
            alias: {
                '@': path.resolve(import.meta.dirname, 'src'),
                '@shared': path.resolve(import.meta.dirname, 'src/shared'),
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
                entry: path.resolve(import.meta.dirname, 'src/appRuntimeHeadless.jsx'),
                formats: ['es'],
                fileName: () => 'app-runtime.mjs',
                cssFileName: 'app-runtime',
            },
            rolldownOptions: {
                output: { codeSplitting: false },
            },
        },
    };
});
