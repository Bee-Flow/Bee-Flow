import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Library build for the Security Scan Studio module frontend.
 *
 * Output: `frontend/index.js` (ESM) + `frontend/index.css`, emitted into the
 * frontend/ root itself (emptyOutDir:false so src/ survives). The host loads
 * index.js via a dynamic import and injects index.css as a <link>.
 *
 * CRITICAL: the whole react family is externalised. The host serves exactly one
 * React via its import map + shim modules (see agent-hub sharedRuntime.js); a
 * module bundling its own React would create a second instance and break hooks.
 * Everything else (lucide-react icons, Tailwind CSS) is bundled so the module is
 * self-contained. Tailwind runs through PostCSS (postcss.config.js) and emits
 * ONLY the utilities these files use — no preflight, so the injected stylesheet
 * never resets the surrounding host page.
 */
export default defineConfig({
    plugins: [react()],
    build: {
        outDir: here,
        emptyOutDir: false,
        cssCodeSplit: false,
        lib: {
            entry: resolve(here, 'src/App.jsx'),
            formats: ['es'],
            fileName: () => 'index.js',
        },
        rollupOptions: {
            external: [
                'react',
                'react-dom',
                'react-dom/client',
                'react/jsx-runtime',
                'react/jsx-dev-runtime',
            ],
            output: {
                assetFileNames: (asset) =>
                    (asset.name && asset.name.endsWith('.css') ? 'index.css' : '[name][extname]'),
            },
        },
    },
});
