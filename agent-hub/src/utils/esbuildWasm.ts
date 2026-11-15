/**
 * esbuild-wasm, loaded once and on demand, for bundling IN THE BROWSER: the
 * react-mui webpage preview (buildWebpagePreview.ts) and the live compile of
 * the CMS's React component block share this one instance.
 *
 * The wasm (~3 MB) is served from the app origin ('self') through Vite's ?url
 * asset import, never a CDN, which matters for self-hosted installs. Callers
 * import this module dynamically, so nothing loads until a bundle is asked for.
 */

let _esbuild: typeof import('esbuild-wasm') | null = null;
let _initPromise: Promise<typeof import('esbuild-wasm')> | null = null;

export async function getEsbuild() {
    if (_esbuild) return _esbuild;
    if (!_initPromise) {
        _initPromise = (async () => {
            const esbuild = await import('esbuild-wasm');
            const wasmURL = (await import('esbuild-wasm/esbuild.wasm?url')).default;
            await esbuild.initialize({ wasmURL, worker: false });
            _esbuild = esbuild;
            return esbuild;
        })().catch((err) => { _initPromise = null; throw err; });
    }
    return _initPromise;
}
