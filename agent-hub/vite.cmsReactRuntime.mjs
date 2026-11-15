import path from 'path'
import { build } from 'vite'

/**
 * The React runtime of the website CMS's `react-component` block, as a string.
 *
 * src/marketing/reactBlock/runtime/entry.ts is bundled with React 19 from this
 * package's own node_modules (production build, minified) into ONE IIFE, and
 * `import runtime from 'virtual:cms-react-runtime'` yields its text. The block
 * renderer inlines that text into the sandboxed frame's srcdoc, so the frame
 * loads React from nobody (no CDN, no import map, nothing a visitor's browser
 * asks a third party for) and needs no file of its own on the server.
 *
 * The renderer imports the module lazily, so it becomes a chunk of its own that
 * only a page with a React block downloads. One plugin for dev, build and
 * vitest (all three load vite.config.js); the bundle is made once per process
 * and again when a file of the runtime changes under the dev server.
 */
export const VIRTUAL_ID = 'virtual:cms-react-runtime'
const RESOLVED_ID = `\0${VIRTUAL_ID}`

/**
 * Bundle the runtime entry into the text of one minified IIFE.
 * @param {string} root the agent-hub directory
 * @param {string} entry absolute path of runtime/entry.ts
 * @returns {Promise<string>}
 */
export async function bundleCmsReactRuntime(root, entry) {
    const result = await build({
        configFile: false,
        root,
        mode: 'production',
        logLevel: 'silent',
        publicDir: false,
        plugins: [],
        resolve: {
            alias: {
                '@': path.resolve(root, 'src'),
                '@shared': path.resolve(root, 'src/shared'),
            },
        },
        // Lib mode keeps process.env.NODE_ENV for the consumer; this bundle IS
        // the consumer, and React picks its production build on this define.
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        build: {
            write: false,
            emptyOutDir: false,
            copyPublicDir: false,
            minify: true,
            sourcemap: false,
            reportCompressedSize: false,
            target: 'es2020',
            lib: { entry, formats: ['iife'], name: '__bfReactRuntime', fileName: () => 'cms-react-runtime.js' },
        },
    })
    const outputs = Array.isArray(result) ? result : [result]
    for (const out of outputs) {
        for (const chunk of out.output || []) {
            if (chunk.type === 'chunk' && chunk.isEntry) return chunk.code
        }
    }
    throw new Error('cms-react-runtime: the bundle produced no entry chunk')
}

/** @param {{ root?: string }} [options] */
export function cmsReactRuntime({ root = import.meta.dirname } = {}) {
    const runtimeDir = path.resolve(root, 'src/marketing/reactBlock/runtime')
    const entry = path.join(runtimeDir, 'entry.ts')
    /** @type {Promise<string> | null} */
    let pending = null
    const bundle = () => {
        if (!pending) pending = bundleCmsReactRuntime(root, entry).catch((err) => { pending = null; throw err })
        return pending
    }
    return {
        name: 'beeflow-cms-react-runtime',
        resolveId(id) {
            return id === VIRTUAL_ID ? RESOLVED_ID : null
        },
        async load(id) {
            if (id !== RESOLVED_ID) return null
            return `export default ${JSON.stringify(await bundle())};`
        },
        configureServer(server) {
            server.watcher.on('change', (file) => {
                if (!file.startsWith(runtimeDir + path.sep)) return
                pending = null
                const mod = server.moduleGraph.getModuleById(RESOLVED_ID)
                if (mod) server.moduleGraph.invalidateModule(mod)
            })
        },
    }
}
