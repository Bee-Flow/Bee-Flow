/**
 * cms_update_react_component: edit the code, stylesheet, fields and props of a
 * React component block (`react-component`) and get the compile outcome back,
 * so an agent can iterate on its errors. Used by the in-product CMS builder
 * and, through the same apply function, by the CMS MCP server.
 *
 * The page is saved through the store like every other edit
 * (builderToolsShared.persistPage -> cmsStore.mutatePage -> setPage), which is
 * where the server compiles the source (stores/cms/reactBlock.mts).
 *
 * `sourceEdits` mirror the blog's bodyEdits (cms/mcp/blog.js): exact
 * find/replace pairs, each `find` must occur exactly once in the source as it
 * stands after the edits before it, applied in order, and nothing is saved
 * when one of them fails.
 */

import { createRequire } from 'node:module';
import { FIELD_TYPES, isPropName, REACT_BLOCK_TYPE, utf8Bytes } from '../shared/cmsReact/compile.mjs';
import {
    compileReactSource, REACT_FIELDS_MAX, REACT_FRAME_TITLE_MAX, REACT_MIN_HEIGHT_MAX, REACT_PROPS_MAX, REACT_WIDTHS,
} from '../stores/cms/reactBlock.mts';
import {
    applySourceEdits as applyEdits, SourceEditFailure, sourceEditsProblem, type SourceEdit,
} from '../utils/sourceEdits.mts';

const nodeRequire = createRequire(import.meta.url);

type Json = Record<string, unknown>;
type Page = { id: string, blocks?: Json[] };
interface Shared {
    clone<T>(v: T): T;
    pageIdsHint(draftWrap: unknown): string;
    blockIdsHint(page: unknown): string;
    findIndexEntry(draftWrap: unknown, pageId: string): unknown;
    getPageDoc(draftWrap: unknown, pageId: string): Promise<Page | null>;
    persistPage(draftWrap: unknown, pageId: string, change: (page: Page) => Page): Promise<{ page: Page }>;
}
const shared = nodeRequire('./builderToolsShared') as Shared;

export { SOURCE_EDITS_MAX, FIND_MAX_CHARS } from '../utils/sourceEdits.mts';

const EDIT_KEYS = ['source', 'sourceEdits', 'css', 'fields', 'props', 'width', 'minHeight', 'frameTitle'];

type ToolError = { error: string, _fixHint?: string };
interface Patch {
    source?: string;
    sourceEdits?: SourceEdit[];
    css?: string;
    fields?: Json[];
    props?: Json;
    width?: string;
    minHeight?: number;
    frameTitle?: string;
}

function isPlainObject(v: unknown): v is Json {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function fail(error: string, fixHint?: string): ToolError {
    return fixHint ? { error, _fixHint: fixHint } : { error };
}

// ── Arguments ───────────────────────────────────────────────────────

function editsProblem(edits: unknown): ToolError | null {
    const problem = sourceEditsProblem(edits);
    return problem ? fail(problem) : null;
}

const FIELDS_HINT = `fields is the COMPLETE list (it replaces the old one): [{ name, label, type, options?, help? }], name a JS identifier (letters, digits, _ or $, max 40), each name once, type one of ${FIELD_TYPES.join(', ')}; a select field lists its options.`;

function fieldsProblem(fields: unknown): ToolError | null {
    if (!Array.isArray(fields)) return fail('fields must be an array.', FIELDS_HINT);
    if (fields.length > REACT_FIELDS_MAX) return fail(`At most ${REACT_FIELDS_MAX} fields.`, FIELDS_HINT);
    const seen = new Set<string>();
    for (const [i, f] of fields.entries()) {
        if (!isPlainObject(f) || !isPropName(f.name)) return fail(`fields[${i}].name is not a valid prop name.`, FIELDS_HINT);
        if (seen.has(String(f.name))) return fail(`fields[${i}].name "${String(f.name)}" is used twice.`, FIELDS_HINT);
        seen.add(String(f.name));
        if (!FIELD_TYPES.includes(String(f.type))) return fail(`fields[${i}].type ${JSON.stringify(f.type)} is not a field type.`, FIELDS_HINT);
        if (f.type === 'select' && !(Array.isArray(f.options) && f.options.length && f.options.every((o) => typeof o === 'string'))) {
            return fail(`fields[${i}] is a select field without options (a list of strings).`, FIELDS_HINT);
        }
    }
    return null;
}

function propsProblem(props: unknown): ToolError | null {
    if (!isPlainObject(props)) return fail('props must be an object of prop name -> value.');
    const bad = Object.keys(props).find((k) => !isPropName(k));
    if (bad !== undefined) return fail(`props key ${JSON.stringify(String(bad).slice(0, 60))} is not a valid prop name.`);
    return null;
}

function scalarProblem(args: Json): ToolError | null {
    if (args.source !== undefined && typeof args.source !== 'string') return fail('source must be the whole file as a string.');
    if (args.source !== undefined && args.sourceEdits !== undefined) return fail('Send either source (whole) or sourceEdits, not both.');
    if (args.css !== undefined && typeof args.css !== 'string') return fail('css must be a string.');
    if (args.width !== undefined && !REACT_WIDTHS.includes(String(args.width))) return fail(`width must be one of ${REACT_WIDTHS.join(', ')}.`);
    if (args.minHeight !== undefined && !(typeof args.minHeight === 'number' && args.minHeight >= 0 && args.minHeight <= REACT_MIN_HEIGHT_MAX)) {
        return fail(`minHeight must be a number of pixels, 0-${REACT_MIN_HEIGHT_MAX}.`);
    }
    return null;
}

function frameTitleProblem(frameTitle: unknown): ToolError | null {
    if (typeof frameTitle === 'string' && frameTitle.length <= REACT_FRAME_TITLE_MAX) return null;
    return fail(`frameTitle must be a string of at most ${REACT_FRAME_TITLE_MAX} characters ('' removes it).`);
}

/** The checked patch, or the first thing wrong with the arguments. */
export function parseReactArgs(args: Json): { patch: Patch } | ToolError {
    if (!EDIT_KEYS.some((k) => args[k] !== undefined)) {
        return fail(`Nothing to change — pass at least one of: ${EDIT_KEYS.join(', ')}.`);
    }
    const problem = scalarProblem(args)
        || (args.frameTitle !== undefined ? frameTitleProblem(args.frameTitle) : null)
        || (args.sourceEdits !== undefined ? editsProblem(args.sourceEdits) : null)
        || (args.fields !== undefined ? fieldsProblem(args.fields) : null)
        || (args.props !== undefined ? propsProblem(args.props) : null);
    if (problem) return problem;
    const patch: Patch = {};
    for (const k of EDIT_KEYS) if (args[k] !== undefined) (patch as Json)[k] = args[k];
    return { patch };
}

// ── Applying ────────────────────────────────────────────────────────

/** Apply find/replace edits in order; throws a SourceEditFailure when a find is missing or not unique. */
export function applySourceEdits(source: string, edits: SourceEdit[]): string {
    return applyEdits(source, edits, 'cms_get_page (content.source)');
}

/** Merge props key by key; a key set to null is removed. */
function mergeProps(current: unknown, patch: Json): Json {
    const out: Json = isPlainObject(current) ? { ...current } : {};
    for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete out[k];
        else out[k] = v;
    }
    return out;
}

function patchContent(content: unknown, patch: Patch): Json {
    const next: Json = isPlainObject(content) ? shared.clone(content) : {};
    if (patch.source !== undefined) next.source = patch.source;
    if (patch.sourceEdits) next.source = applySourceEdits(typeof next.source === 'string' ? next.source : '', patch.sourceEdits);
    if (patch.css !== undefined) next.css = patch.css;
    if (patch.fields !== undefined) next.fields = shared.clone(patch.fields);
    if (patch.props !== undefined) next.props = mergeProps(next.props, patch.props);
    if (patch.width !== undefined) next.width = patch.width;
    if (patch.minHeight !== undefined) next.minHeight = patch.minHeight;
    if (patch.frameTitle !== undefined) next.frameTitle = patch.frameTitle;
    return next;
}

function tooManyProps(content: Json): ToolError | null {
    const count = isPlainObject(content.props) ? Object.keys(content.props).length : 0;
    return count > REACT_PROPS_MAX ? fail(`A block holds at most ${REACT_PROPS_MAX} props; remove some (a key set to null is removed).`) : null;
}

/** Locate the block, or say why it cannot be edited with this tool. */
async function findReactBlock(draftWrap: unknown, args: Json): Promise<{ pageId: string, blockId: string, page: Page } | ToolError> {
    const pageId = typeof args.pageId === 'string' ? args.pageId : '';
    if (!pageId || !shared.findIndexEntry(draftWrap, pageId)) {
        return fail(`Unknown pageId ${JSON.stringify(args.pageId ?? null)}.`, shared.pageIdsHint(draftWrap));
    }
    const page = await shared.getPageDoc(draftWrap, pageId);
    if (!page) return fail(`Page document for ${pageId} is missing.`, shared.pageIdsHint(draftWrap));
    const blockId = typeof args.blockId === 'string' ? args.blockId : '';
    const block = (page.blocks || []).find((b) => b.id === blockId);
    if (!block) return fail(`Unknown blockId ${JSON.stringify(args.blockId ?? null)} on page ${pageId}.`, shared.blockIdsHint(page));
    if (block.type !== REACT_BLOCK_TYPE) {
        return fail(`Block ${blockId} is a ${String(block.type)} block, not a ${REACT_BLOCK_TYPE} block.`, 'Use cms_update_block for other block types, or add a react-component block with cms_add_blocks.');
    }
    return { pageId, blockId, page };
}

/** The compile outcome of the saved block, for the caller to iterate on. */
async function compileReport(saved: Json | undefined): Promise<Json> {
    const content = isPlainObject(saved?.content) ? saved.content : {};
    const source = typeof content.source === 'string' ? content.source : '';
    const compiled = typeof content.compiled === 'string' && content.compiled !== '';
    // Cached: the save compiled this very source a moment ago.
    const outcome = await compileReactSource(source);
    return {
        ok: compiled,
        compiled,
        compileError: typeof content.compileError === 'string' ? content.compileError : '',
        diagnostics: outcome.diagnostics.slice(0, 20),
        sourceBytes: utf8Bytes(source),
    };
}

export async function applyUpdateReactComponent(draftWrap: unknown, rawArgs: unknown): Promise<Json> {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const found = await findReactBlock(draftWrap, args);
    if ('error' in found) return found;
    const parsed = parseReactArgs(args);
    if ('error' in parsed) return parsed;
    const { pageId, blockId } = found;
    let saved: Json | undefined;
    try {
        const { page } = await shared.persistPage(draftWrap, pageId, (d) => {
            const at = (d.blocks || []).findIndex((b) => b.id === blockId);
            if (at < 0 || d.blocks?.[at]?.type !== REACT_BLOCK_TYPE) throw new SourceEditFailure(`Block ${blockId} was removed from page ${pageId} by another edit.`, shared.blockIdsHint(d));
            const blocks = [...(d.blocks || [])];
            const content = patchContent(blocks[at].content, parsed.patch);
            const tooMany = tooManyProps(content);
            if (tooMany) throw new SourceEditFailure(tooMany.error, '');
            blocks[at] = { ...blocks[at], content };
            return { ...d, blocks };
        });
        saved = (page.blocks || []).find((b) => b.id === blockId);
    } catch (e) {
        if (e instanceof SourceEditFailure) return fail(e.message, e.fixHint || undefined);
        throw e;
    }
    return { pageId, blockId, type: REACT_BLOCK_TYPE, ...(await compileReport(saved)) };
}
