/**
 * The React component block (`react-component`) on the server: the shape its
 * content may have, the compile on every save, what a translation may change,
 * and how the compiled code is shown to a reader.
 *
 * Content (see BLOCK_DEFAULTS['react-component'] in i18n/defaults/cmsDefaults.js):
 *
 *   { source, css, fields: [{ name, label, type, options?, help? }], props: { name: value },
 *     width: 'container' | 'full', minHeight, compiled, compileError }
 *
 * `compiled` and `compileError` belong to the server. setPage (./pages.js)
 * runs every react-component block through prepareReactBlocks before the
 * write, so whatever a client sent there is replaced by the outcome of
 * compiling `source` here, with the compiler both sides share
 * (shared/cmsReact/compile.mjs) and native esbuild.
 *
 * Lives in stores/ (platform) rather than core/cms/: the store calls it on
 * every save, and a store may not require core (server/layering.test.js).
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
    compileReactBlock, FIELD_TYPES, isPropName, REACT_BLOCK_TYPE, utf8Bytes,
} from '../../shared/cmsReact/compile.mjs';
import { envInt } from '../../utils/envNumber.mts';

const nodeRequire = createRequire(import.meta.url);

export { REACT_BLOCK_TYPE };

export interface ReactField {
    name: string;
    label: string;
    type: string;
    options?: string[];
    help?: string;
}

export interface CompileDiagnostic {
    line: number;
    column: number;
    text: string;
}

export interface CompileOutcome {
    ok: boolean;
    code: string;
    error: string;
    diagnostics: CompileDiagnostic[];
}

type Json = Record<string, unknown>;

export const REACT_WIDTHS = Object.freeze(['container', 'full']);
export const REACT_MIN_HEIGHT_DEFAULT = 240;
export const REACT_MIN_HEIGHT_MAX = 4000;
export const REACT_FIELDS_MAX = 40;
export const REACT_PROPS_MAX = 80;
const SELECT_OPTIONS_MAX = 50;
const LABEL_MAX = 80;
const HELP_MAX = 300;
const OPTION_MAX = 200;
/** Experiment fields every block may carry (cmsBuilder/experiments.js); abAlt is limited below. */
const AB_KEYS = ['abKey', 'abShare', 'abGoal'];

/** Source size limit in bytes (UTF-8); 0 means no limit. */
export function reactSourceMaxBytes(): number {
    return envInt('CMS_REACT_SOURCE_MAX_BYTES', 200000, { min: 0 });
}

function isPlainObject(v: unknown): v is Json {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function jsonClone<T>(v: T): T {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

// ── Compile ─────────────────────────────────────────────────────────

const CACHE_MAX = 64;
const cache = new Map<string, CompileOutcome>();

function cacheKey(source: string, max: number): string {
    return createHash('sha256').update(`${max}\u0000${source}`).digest('hex');
}

function remember(key: string, outcome: CompileOutcome): void {
    cache.set(key, outcome);
    if (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
}

/**
 * Compile one component source with native esbuild. Never throws. The result
 * of a source is cached (a page save recompiles every react block on the page,
 * mostly unchanged).
 */
export async function compileReactSource(source: unknown): Promise<CompileOutcome> {
    const max = reactSourceMaxBytes();
    const text = typeof source === 'string' ? source : '';
    const key = cacheKey(text, max);
    const hit = cache.get(key);
    if (hit) return hit;
    const esbuild = nodeRequire('esbuild');
    const res = await compileReactBlock(esbuild, text, { maxSourceBytes: max });
    const outcome: CompileOutcome = res.ok
        ? { ok: true, code: res.code, error: '', diagnostics: [] }
        : { ok: false, code: '', error: res.error, diagnostics: res.diagnostics };
    remember(key, outcome);
    return outcome;
}

// ── Content shape ───────────────────────────────────────────────────

function cleanText(v: unknown, max: number): string {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function cleanOptions(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.filter((o): o is string => typeof o === 'string').map((o) => o.slice(0, OPTION_MAX)).slice(0, SELECT_OPTIONS_MAX);
}

/** One field, or null when it has no usable name. An unknown type becomes 'text'. */
function cleanField(raw: unknown): ReactField | null {
    if (!isPlainObject(raw) || !isPropName(raw.name)) return null;
    const name = String(raw.name);
    const type = FIELD_TYPES.includes(String(raw.type)) ? String(raw.type) : 'text';
    const field: ReactField = { name, label: cleanText(raw.label, LABEL_MAX) || name, type };
    if (type === 'select') field.options = cleanOptions(raw.options);
    const help = cleanText(raw.help, HELP_MAX);
    if (help) field.help = help;
    return field;
}

/** The declared fields: valid names, each name once (the first wins), at most REACT_FIELDS_MAX. */
export function cleanFields(raw: unknown): ReactField[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: ReactField[] = [];
    for (const entry of raw) {
        const field = cleanField(entry);
        if (!field || seen.has(field.name)) continue;
        seen.add(field.name);
        out.push(field);
        if (out.length >= REACT_FIELDS_MAX) break;
    }
    return out;
}

/** Prop values by name: valid names only, JSON values only. Undeclared props are kept (harmless). */
export function cleanProps(raw: unknown): Json {
    if (!isPlainObject(raw)) return {};
    const out: Json = {};
    for (const [name, value] of Object.entries(raw)) {
        if (Object.keys(out).length >= REACT_PROPS_MAX) break;
        if (!isPropName(name) || value === undefined || typeof value === 'function') continue;
        if (typeof value === 'number' && !Number.isFinite(value)) continue;
        out[name] = jsonClone(value);
    }
    return out;
}

function cleanMinHeight(v: unknown): number {
    const n = typeof v === 'number' ? v : Number.NaN;
    if (!Number.isFinite(n)) return REACT_MIN_HEIGHT_DEFAULT;
    return Math.min(REACT_MIN_HEIGHT_MAX, Math.max(0, Math.round(n)));
}

/**
 * The content of a react-component block, rebuilt from an allow-list of keys
 * (a key a client invents is not stored). `compiled` and `compileError` start
 * empty: prepareReactContent fills them.
 */
export function sanitizeReactContent(raw: unknown): Json {
    const c = isPlainObject(raw) ? raw : {};
    const out: Json = {
        source: typeof c.source === 'string' ? c.source : '',
        css: typeof c.css === 'string' ? c.css : '',
        fields: cleanFields(c.fields),
        props: cleanProps(c.props),
        width: REACT_WIDTHS.includes(String(c.width)) ? c.width : 'container',
        minHeight: cleanMinHeight(c.minHeight),
        compiled: '',
        compileError: '',
    };
    for (const k of AB_KEYS) if (c[k] !== undefined) out[k] = jsonClone(c[k]);
    // The alternative of an A/B test may change props only, never the code.
    if (isPlainObject(c.abAlt)) out.abAlt = reactOverrideContent(c.abAlt);
    return out;
}

/** Clean shape plus the server's compile of `source`. */
export async function prepareReactContent(raw: unknown): Promise<Json> {
    const content = sanitizeReactContent(raw);
    const outcome = await compileReactSource(content.source);
    content.compiled = outcome.code;
    content.compileError = outcome.ok ? '' : outcome.error;
    return content;
}

/**
 * Every react-component block of a page with its content cleaned and
 * compiled; other blocks are returned as they are (same objects).
 */
export async function prepareReactBlocks<B extends { type?: unknown, content?: unknown }>(blocks: B[]): Promise<B[]> {
    return Promise.all(blocks.map(async (b) => (b && b.type === REACT_BLOCK_TYPE
        ? { ...b, content: await prepareReactContent(b.content) }
        : b)));
}

// ── Translations ────────────────────────────────────────────────────

/**
 * What a locale override (or an A/B alternative) of a react-component block
 * may carry: `props`, nothing else. Built from that allow-list, so a stale
 * override can never shadow `compiled`, `source` or `fields`.
 */
export function reactOverrideContent(raw: unknown): Json {
    if (!isPlainObject(raw) || !isPlainObject(raw.props)) return {};
    const props = cleanProps(raw.props);
    return Object.keys(props).length ? { props } : {};
}

/**
 * A page override's entry for one block, cleaned for a react-component block:
 * `{ content: { props } }` and the parked translations (`_orphans`) the
 * re-aligner keeps.
 */
export function reactBlockOverride(raw: unknown): Json {
    if (!isPlainObject(raw)) return {};
    const out: Json = { content: reactOverrideContent(raw.content) };
    if (isPlainObject(raw._orphans)) out._orphans = raw._orphans;
    return out;
}

/** The ids of the react-component blocks of a stored page. */
export function reactBlockIds(page: unknown): Set<string> {
    const blocks = isPlainObject(page) && Array.isArray(page.blocks) ? page.blocks : [];
    return new Set(blocks
        .filter((b: unknown) => isPlainObject(b) && b.type === REACT_BLOCK_TYPE && typeof b.id === 'string')
        .map((b: Json) => String(b.id)));
}

/**
 * What a page override sent for react-component blocks that is not stored
 * (everything but props), as one sentence for the caller; '' when nothing.
 */
export function reactOverrideNote(override: unknown, page: unknown): string {
    const blocks = isPlainObject(override) && isPlainObject(override.blocks) ? override.blocks : {};
    const dropped: string[] = [];
    for (const id of reactBlockIds(page)) {
        const sent = blocks[id];
        const content = isPlainObject(sent) && isPlainObject(sent.content) ? sent.content : {};
        for (const k of Object.keys(content)) if (k !== 'props') dropped.push(`${id}.${k}`);
    }
    if (!dropped.length) return '';
    return `A React component block translates its props only; not stored: ${dropped.slice(0, 10).join(', ')}. Translate text props under content.props.`;
}

// ── Reading ─────────────────────────────────────────────────────────

/** `compiled` as a reader sees it: a note with its size instead of the code. */
export function compiledNote(compiled: unknown): string {
    if (typeof compiled !== 'string' || !compiled) return '';
    return `<compiled: ${utf8Bytes(compiled)} bytes>`;
}

/**
 * A copy of a page for a reader (cms_get_page, the builder's site state): the
 * compiled code of every react-component block replaced by a short note. It
 * is noise to a model and ignored on input anyway.
 */
export function redactCompiledPage<P>(page: P): P {
    if (!isPlainObject(page) || !Array.isArray(page.blocks)) return page;
    if (!page.blocks.some((b: unknown) => isPlainObject(b) && b.type === REACT_BLOCK_TYPE)) return page;
    const blocks = page.blocks.map((b: unknown) => {
        if (!isPlainObject(b) || b.type !== REACT_BLOCK_TYPE || !isPlainObject(b.content)) return b;
        return { ...b, content: { ...b.content, compiled: compiledNote(b.content.compiled) } };
    });
    return { ...page, blocks } as P;
}

/** For tests: forget the compile cache. */
export function _clearCompileCache(): void {
    cache.clear();
}
