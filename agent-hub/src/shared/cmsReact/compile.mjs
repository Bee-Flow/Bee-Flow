// @typecheck strict
/**
 * The React component block of the website CMS (`react-component`): the one
 * compiler both sides use. The server compiles on every page save (native
 * esbuild, core/cms/reactBlock.js) and stores the result in the block; the
 * admin editor compiles the same source in the browser (esbuild-wasm) for its
 * live preview and error markers. One set of options, so the preview runs the
 * code the published page will run.
 *
 * The author writes ONE TSX/JSX file with a default export:
 *
 *     import { useState } from 'react';
 *     export default function Counter({ label }: { label: string }) { … }
 *
 * The output is a CommonJS function body: `require('react')` etc. are resolved
 * inside the sandboxed iframe by the self-hosted runtime (agent-hub
 * src/marketing/reactBlock/runtime), never by a CDN, so a visitor's browser
 * talks to nobody but this site. Only the packages in ALLOWED_IMPORTS exist
 * there; any other import is a compile error that names them.
 *
 * The bundler is passed in (esbuild and esbuild-wasm share the build API).
 * Plain functions, no platform API.
 *
 * Edit this file, never the mirror; then run `npm run gen:shared`.
 */

export const REACT_BLOCK_TYPE = 'react-component';

/** The file name diagnostics point at. */
export const REACT_BLOCK_FILE = 'component.tsx';

/** The modules a component may import; the iframe runtime provides exactly these. */
export const ALLOWED_IMPORTS = Object.freeze([
    'react',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'react-dom',
    'react-dom/client',
]);

/** The kinds of editable prop a block can declare in `content.fields`. */
export const FIELD_TYPES = Object.freeze(['text', 'textarea', 'number', 'boolean', 'color', 'image', 'link', 'select']);

/**
 * The site theme as CSS variables on the frame's `:root`: the page reads them
 * from the block's section (colours, fonts, corner radius) and passes them in.
 * A component uses them with a fallback, `var(--bf-primary, #F5A623)`, so it
 * also renders on its own.
 */
export const REACT_THEME_VARS = Object.freeze([
    '--bf-primary', '--bf-secondary', '--bf-accent', '--bf-background', '--bf-surface',
    '--bf-text', '--bf-text-secondary', '--bf-font-body', '--bf-font-heading', '--bf-radius',
]);

/** A prop name: what a JS identifier allows, short. @param {unknown} name @returns {name is string} */
export function isPropName(name) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 40) return false;
    for (let i = 0; i < name.length; i += 1) {
        const c = name.charCodeAt(i);
        const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
        const digit = c >= 48 && c <= 57;
        if (!(letter || (i > 0 && digit))) return false;
    }
    return true;
}

/** Bytes of a string as UTF-8, without a platform API. @param {string} s */
export function utf8Bytes(s) {
    let n = 0;
    for (let i = 0; i < s.length; i += 1) {
        const c = s.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i += 1; }
        else n += 3;
    }
    return n;
}

/**
 * @typedef {{ line: number, column: number, text: string }} CompileDiagnostic
 *   line is 1-based, column 0-based (esbuild's convention); 0/0 when unknown.
 * @typedef {{ ok: true, code: string, diagnostics: CompileDiagnostic[] }
 *   | { ok: false, error: string, diagnostics: CompileDiagnostic[] }} CompileResult
 */

/** @param {any} msg @returns {CompileDiagnostic} */
function toDiagnostic(msg) {
    const loc = msg && msg.location;
    return {
        line: loc && Number.isFinite(loc.line) ? loc.line : 0,
        column: loc && Number.isFinite(loc.column) ? loc.column : 0,
        text: String((msg && msg.text) || 'Unknown error'),
    };
}

/** @param {CompileDiagnostic[]} list */
function formatDiagnostics(list) {
    return list.slice(0, 10)
        .map(d => (d.line ? `${REACT_BLOCK_FILE}:${d.line}:${d.column + 1}: ${d.text}` : d.text))
        .join('\n');
}

/** @param {string} error @param {CompileDiagnostic[]} [diagnostics] @returns {CompileResult} */
function fail(error, diagnostics = []) {
    return { ok: false, error, diagnostics: diagnostics.length ? diagnostics : [{ line: 0, column: 0, text: error }] };
}

/** esbuild plugin: the allowed packages stay external, everything else is an error. */
function importGuardPlugin() {
    return {
        name: 'beeflow-cms-react-imports',
        /** @param {{ onResolve: (opts: { filter: RegExp }, cb: (args: { path: string }) => object) => void }} build */
        setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
                if (ALLOWED_IMPORTS.includes(args.path)) return { path: args.path, external: true };
                return {
                    errors: [{
                        text: `"${args.path}" cannot be imported here. A React component block is one file and may import only: ${ALLOWED_IMPORTS.join(', ')}.`,
                    }],
                };
            });
        },
    };
}

/** @param {any} err @returns {CompileDiagnostic[]} */
function diagnosticsOf(err) {
    const errors = err && Array.isArray(err.errors) ? err.errors : [];
    return errors.map(toDiagnostic);
}

/** @param {any} err @returns {CompileResult} */
function failFromError(err) {
    const diagnostics = diagnosticsOf(err);
    return fail(diagnostics.length ? formatDiagnostics(diagnostics) : String((err && err.message) || err), diagnostics);
}

/** @param {unknown} source @param {number} max @returns {string | null} why the source cannot be compiled */
function sourceProblem(source, max) {
    if (typeof source !== 'string' || source.trim() === '') {
        return 'The component has no code yet. Write a file with a default export, e.g. export default function Block() { return <p>Hello</p>; }';
    }
    if (max > 0 && utf8Bytes(source) > max) {
        return `The component source is larger than ${max} bytes; split it up or raise CMS_REACT_SOURCE_MAX_BYTES.`;
    }
    return null;
}

/** Pass 1: ESM, so the metafile can say whether there is a default export. @param {any} esbuild @param {string} source */
function buildEsm(esbuild, source) {
    return esbuild.build({
        stdin: { contents: source, loader: 'tsx', sourcefile: REACT_BLOCK_FILE },
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2020',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"' },
        legalComments: 'none',
        metafile: true,
        write: false,
        logLevel: 'silent',
        plugins: [importGuardPlugin()],
    });
}

/** @param {any} result the build result of buildEsm */
function hasDefaultExport(result) {
    const outputs = result && result.metafile ? Object.values(result.metafile.outputs) : [];
    const first = /** @type {any} */ (outputs[0]);
    return !!first && Array.isArray(first.exports) && first.exports.includes('default');
}

/**
 * Compile one component source to a CommonJS body for the iframe runtime.
 * Never throws: a broken source is `{ ok: false, error, diagnostics }`.
 *
 * @param {any} esbuild  native esbuild or an initialised esbuild-wasm
 * @param {unknown} source
 * @param {{ maxSourceBytes?: number }} [opts]  0 or absent = no limit
 * @returns {Promise<CompileResult>}
 */
export async function compileReactBlock(esbuild, source, opts = {}) {
    const problem = sourceProblem(source, Number(opts.maxSourceBytes) || 0);
    if (problem) return fail(problem);
    let esm;
    try {
        esm = await buildEsm(esbuild, /** @type {string} */ (source));
    } catch (err) {
        return failFromError(err);
    }
    if (!hasDefaultExport(esm)) {
        return fail('The component has no default export. Export the component to render: export default function Block(props) { … }');
    }
    const esmCode = esm.outputFiles && esm.outputFiles[0] ? esm.outputFiles[0].text : '';
    // Pass 2: CommonJS, so the runtime can hand `require` the allowed modules.
    try {
        const cjs = await esbuild.transform(esmCode, { loader: 'js', format: 'cjs', target: 'es2020', legalComments: 'none', logLevel: 'silent' });
        return { ok: true, code: cjs.code, diagnostics: [] };
    } catch (err) {
        return failFromError(err);
    }
}
