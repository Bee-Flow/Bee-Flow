import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Library build for a Bee Flow module frontend.
 *
 * Output: `frontend/index.js` (ESM) + `frontend/index.css`, emitted into the
 * frontend/ root itself (emptyOutDir:false so src/ survives). pack.mjs then
 * zips frontend/index.js + frontend/index.css alongside the built server.
 *
 * CRITICAL: react / react-dom / their entrypoints AND jsx-runtime are
 * externalised. The host serves exactly one React via an import map + shim
 * modules; a module bundling its own React would create a second instance and
 * break hooks. Bundle everything else (including icons).
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
