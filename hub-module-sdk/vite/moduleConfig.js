import { resolve } from 'node:path';

/**
 * The react family the host serves through its import map + shim modules (see
 * agent-hub sharedRuntime.js). A module bundling its own React would create a
 * second instance and break hooks, so these are always externalised.
 */
export const HOST_PROVIDED_EXTERNALS = Object.freeze([
    'react',
    'react-dom',
    'react-dom/client',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
]);

/**
 * Vite library-build config for a Bee Flow Hub module frontend.
 *
 * Output: `frontend/index.js` (ESM) + `frontend/index.css`, emitted into the
 * frontend/ root itself (emptyOutDir:false so src/ survives). pack.mjs zips
 * both alongside the built server; the host loads index.js via a dynamic import
 * and injects index.css as a <link>. Everything except the react family is
 * bundled so the module is self-contained.
 *
 * Plain data, no vite import: the SDK does not depend on vite, so the module's
 * vite.config.js passes its own plugins and wraps the result in defineConfig.
 *
 * @param {object}   opts
 * @param {string}   opts.here       absolute path of the module's frontend/ dir
 * @param {Array}    [opts.plugins]  vite plugins (e.g. [react()])
 * @param {string}   [opts.entry='src/App.jsx'] entry, relative to `here`
 * @returns {object} a vite UserConfig
 */
export function moduleViteConfig({ here, plugins = [], entry = 'src/App.jsx' }) {
    return {
        plugins,
        build: {
            outDir: here,
            emptyOutDir: false,
            cssCodeSplit: false,
            lib: {
                entry: resolve(here, entry),
                formats: ['es'],
                fileName: () => 'index.js',
            },
            rollupOptions: {
                external: [...HOST_PROVIDED_EXTERNALS],
                output: {
                    assetFileNames: (asset) =>
                        (asset.name && asset.name.endsWith('.css') ? 'index.css' : '[name][extname]'),
                },
            },
        },
    };
}
