/**
 * Custom block: the one prop of a `custom_block` node, `props.block`, cleaned.
 *
 *   block: {
 *     template: '<ul><li data-each="rows">{{ item.name }}</li></ul>',   // HTML template, no script
 *     css?: 'li { color: var(--bf-primary) }',                         // the block's stylesheet
 *     inputs?: { rows: { kind: 'records', tableId: 'tbl_x' } },        // name -> binding: all a formula sees
 *     events?: { pick: 'act_x' },                                      // event name -> action (null: not wired)
 *   }
 *
 * This is the objectShape `customBlock` (componentSpecs/objectShapes.js): the canonicalizer
 * stores what cleanCustomBlock returns, and the validator calls it again and reports every
 * repair it would still make, so a definition that never passed the canonicalizer gets the
 * same findings. The template is read strictly and held to the vocabulary
 * (server/shared/blockTemplate), the stylesheet goes through blockCss.mts; each thing that is
 * left out is one repair, with the template line it was on.
 *
 * A binding keeps what is written (the validator checks it, validate/customBlockChecks.mts), like
 * the bindings inside the base list props. Unlike those (schema 2), the block writes its inputs and
 * events by name and the keys inside a binding in one fixed order (`kind` first, the rest by name),
 * so a definition read back from JSONB canonicalizes to the same bytes.
 */

import { BLOCK_LIMITS, RESERVED_NAMES, canonicalTemplate, isBlockName } from '../../shared/blockTemplate/index.mjs';
import { sanitizeBlockCss } from './blockCss.mts';
import { blockSaveLimits } from './blockLimits.mts';

type Push = (code: string, path: string, message: string) => void;
export type BlockValue = {
    template: string;
    css?: string;
    inputs?: Record<string, unknown>;
    events?: Record<string, string | null>;
};

const KEYS = ['template', 'css', 'inputs', 'events'];
const MAX_REPORTED = 40;
const MAX_ACTION_ID_LEN = 80;

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function plainCopy(value: unknown): unknown {
    try { return JSON.parse(JSON.stringify(value)); } catch { return undefined; }
}

/** The entries of a name -> value map that carry a usable name and value; the rest is reported. */
function cleanMap<V>(raw: unknown, what: string, max: number, path: string, push: Push, value: (v: unknown) => V | undefined): Record<string, V> | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!isObject(raw)) { push('block.invalid', path, `${what} is an object of name: value entries; it was left out.`); return undefined; }
    const out: Record<string, V> = {};
    let kept = 0;
    // By name, so the stored bytes do not depend on the order the keys were read back in.
    for (const [name, entry] of Object.entries(raw).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const at = `${path}.${name.slice(0, 40)}`;
        if (!isBlockName(name) || RESERVED_NAMES.includes(name)) {
            push('block.name_invalid', at, `${JSON.stringify(name.slice(0, 40))} is not a name ${what} can use (a letter, then letters, digits or "_"; not ${RESERVED_NAMES.slice(0, 2).join(' or ')}); the entry was left out.`);
            continue;
        }
        if (kept >= max) { push('block.too_many', path, `${what} holds at most ${max} entries; the rest was left out.`); break; }
        const cleaned = value(entry);
        if (cleaned === undefined) { push('block.entry_invalid', at, `The entry ${name} of ${what} has no usable value and was left out.`); continue; }
        out[name] = cleaned;
        kept += 1;
    }
    return kept ? out : undefined;
}

/** A copy with the keys of every object in one fixed order: `kind` first, the rest by name. */
function inKeyOrder(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(inKeyOrder);
    if (!isObject(value)) return value;
    const keys = Object.keys(value).sort((a, b) => (a === 'kind' ? -1 : b === 'kind' ? 1 : a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map((k) => [k, inKeyOrder(value[k])]));
}

const asBinding = (v: unknown): unknown => (isObject(v) && typeof v.kind === 'string' ? inKeyOrder(plainCopy(v)) : undefined);
const asActionId = (v: unknown): string | null | undefined => {
    if (v === null || v === '') return null;
    return typeof v === 'string' && v.length <= MAX_ACTION_ID_LEN ? v : undefined;
};

function cleanTemplate(raw: unknown, path: string, push: Push): string {
    if (raw === undefined || raw === null) return '';
    if (typeof raw !== 'string') { push('block.invalid', path, 'template is a text; it was reset to empty.'); return ''; }
    const { template, findings } = canonicalTemplate(raw, blockSaveLimits());
    findings.slice(0, MAX_REPORTED).forEach((f) => push(f.code, path, `Template line ${f.line}: ${f.message}`));
    if (findings.length > MAX_REPORTED) push('template.more', path, `…and ${findings.length - MAX_REPORTED} more of the same kind.`);
    return template;
}

function cleanCss(raw: unknown, path: string, push: Push): string {
    if (raw === undefined || raw === null) return '';
    if (typeof raw !== 'string') { push('block.invalid', path, 'css is a text; it was left out.'); return ''; }
    const { css, removed } = sanitizeBlockCss(raw);
    if (removed.length) push('block.css', path, `Removed from the block's stylesheet because it is not allowed there: ${removed.join(', ')}.`);
    return css;
}

/** The value of `props.block` as it is stored; undefined when there is nothing usable. */
export function cleanCustomBlock(raw: unknown, push: Push, path: string): BlockValue | undefined {
    if (!isObject(raw)) { push('block.invalid', path, 'block is an object { template, css, inputs, events }; it was left out.'); return undefined; }
    for (const key of Object.keys(raw)) {
        if (!KEYS.includes(key)) push('block.key_unknown', `${path}.${key.slice(0, 40)}`, `A block has no key ${JSON.stringify(key.slice(0, 40))}; it was left out. The keys are ${KEYS.join(', ')}.`);
    }
    const out: BlockValue = { template: cleanTemplate(raw.template, `${path}.template`, push) };
    const css = cleanCss(raw.css, `${path}.css`, push);
    if (css) out.css = css;
    const inputs = cleanMap(raw.inputs, 'inputs', BLOCK_LIMITS.MAX_INPUTS, `${path}.inputs`, push, asBinding);
    if (inputs) out.inputs = inputs;
    const events = cleanMap(raw.events, 'events', BLOCK_LIMITS.MAX_EVENTS, `${path}.events`, push, asActionId);
    if (events) out.events = events;
    return out;
}
