/**
 * React block: the one prop of a `react_block` node, `props.block`, cleaned.
 *
 *   block: {
 *     source: 'export default function Sim({ rate, emit }) { … }',  // one TSX file, default export
 *     css?: '.sim { … }',                                          // the block's stylesheet
 *     inputs?: { rate: { kind: 'formula', expr: 'vars.rate' } },   // name -> binding: all the component sees
 *     events?: { pick: 'act_x' },                                  // event name -> action (null: not wired)
 *     compiled?: '…',          // what app_edit_react_block compiled from `source` (shared/cmsReact)
 *     compileError?: '…',      // why that compile failed
 *     compiledFor?: 'k3-1x9a', // sourceStamp(source) of the source the two above belong to
 *   }
 *
 * This is the objectShape `reactBlock` (componentSpecs/objectShapes.js). The stylesheet, the
 * inputs and the events follow the custom_block's rules (./blockShape.mts). The canonicalizer is
 * synchronous and runs everywhere a definition is read (also on the phone), so it does not
 * compile: app_edit_react_block compiles on save and writes `compiled` with `compiledFor`. When
 * the source changed by any other way, the stamp no longer matches and the compile outcome is
 * left out, so a block never draws code that belongs to an older source.
 *
 * The stamp is no security boundary, and does not need to be one: whoever can write `compiled`
 * can write `source`, and both run in the same sealed frame (no network, no same-origin, data
 * only through the declared inputs; agent-hub …/runtime/components/reactBlock/).
 */

import { cleanBlockParts, reportUnknownKeys, type BlockParts } from './blockShape.mts';
import { reactSourceMaxChars } from './blockLimits.mts';

type Push = (code: string, path: string, message: string) => void;
export type ReactBlockValue = BlockParts & {
    source: string;
    compiled?: string;
    compileError?: string;
    compiledFor?: string;
};

export const REACT_BLOCK_KEYS: readonly string[] = Object.freeze(['source', 'css', 'inputs', 'events', 'compiled', 'compileError', 'compiledFor']);
/** The names a component reads besides its inputs: an input cannot take them. */
export const REACT_RESERVED_PROPS: readonly string[] = Object.freeze(['emit', 'children', 'key', 'ref']);
const COMPILE_ERROR_MAX = 4000;
const COMPILED_FACTOR = 4;

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * A short fingerprint of a source text (its length and an FNV-1a hash of its UTF-16 units).
 * Pure, so the phone and the browser could compute it too.
 */
export function sourceStamp(source: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < source.length; i += 1) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${source.length.toString(36)}-${hash.toString(36)}`;
}

function cleanSource(raw: unknown, path: string, push: Push): string {
    if (raw === undefined || raw === null) return '';
    if (typeof raw !== 'string') { push('block.invalid', path, 'source is a text (one TSX file); it was reset to empty.'); return ''; }
    const max = reactSourceMaxChars();
    if (raw.length > max) { push('block.too_long', path, `source is longer than ${max} characters; it was left out.`); return ''; }
    return raw;
}

type CompileParts = Pick<ReactBlockValue, 'compiled' | 'compileError' | 'compiledFor'>;

/** The compiled code and the error of a stamp that matches, each only when usable. */
function usableOutcome(raw: Record<string, unknown>, path: string, push: Push): CompileParts {
    const out: CompileParts = {};
    const compiledMax = reactSourceMaxChars() * COMPILED_FACTOR;
    if (typeof raw.compiled === 'string' && raw.compiled && raw.compiled.length <= compiledMax) out.compiled = raw.compiled;
    else if (raw.compiled !== undefined && raw.compiled !== '') push('block.invalid', `${path}.compiled`, 'compiled is not usable compiled code; it was left out.');
    if (typeof raw.compileError === 'string' && raw.compileError) out.compileError = raw.compileError.slice(0, COMPILE_ERROR_MAX);
    return out;
}

/** `compiled`, `compileError` and `compiledFor`, kept only while they belong to `source`. */
function cleanCompiled(raw: Record<string, unknown>, source: string, path: string, push: Push): CompileParts {
    if (raw.compiled === undefined && raw.compileError === undefined && raw.compiledFor === undefined) return {};
    const stamp = source ? sourceStamp(source) : '';
    if (!stamp || raw.compiledFor !== stamp) {
        push('block.stale_compile', `${path}.compiled`, 'The compiled code belongs to another source and was left out. Save the source with app_edit_react_block to compile it.');
        return {};
    }
    const out = usableOutcome(raw, path, push);
    if (out.compiled === undefined && out.compileError === undefined) return {};
    out.compiledFor = stamp;
    return out;
}

/** Inputs named like a prop the frame hands the component itself are reported and left out. */
function withoutReservedInputs(parts: BlockParts, path: string, push: Push): BlockParts {
    if (!parts.inputs) return parts;
    const inputs = { ...parts.inputs };
    for (const name of REACT_RESERVED_PROPS) {
        if (!Object.hasOwn(inputs, name)) continue;
        push('block.name_invalid', `${path}.inputs.${name}`, `"${name}" is a prop the frame gives the component itself; the input was left out. Use another name.`);
        delete inputs[name];
    }
    const out = { ...parts };
    if (Object.keys(inputs).length) out.inputs = inputs; else delete out.inputs;
    return out;
}

/** The value of `props.block` of a react_block as it is stored; undefined when there is nothing usable. */
export function cleanReactBlock(raw: unknown, push: Push, path: string): ReactBlockValue | undefined {
    if (!isObject(raw)) { push('block.invalid', path, 'block is an object { source, css, inputs, events }; it was left out.'); return undefined; }
    reportUnknownKeys(raw, REACT_BLOCK_KEYS, path, push);
    const source = cleanSource(raw.source, `${path}.source`, push);
    const parts = withoutReservedInputs(cleanBlockParts(raw, push, path), path, push);
    return { source, ...parts, ...cleanCompiled(raw, source, path, push) };
}
