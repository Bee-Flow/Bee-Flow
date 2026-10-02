import { defaultIntent, lowerPick, sourceFromPath } from '@shared/mapping/index.mjs';
import type { MappingSource, Slot, Source } from '@shared/mapping/index.mjs';
import { bindingFromInput, isCleanPath, TEMPLATE_RE } from '../../../../utils/bindingHelpers';
import { pickableSource } from '../valueSlot/slotDnd';
import { makePick, shapeAt } from '../valueSlot/slotModel';
import { classifyRef } from './refTokens';

/**
 * The pure half of BindingField (the formula editor): what its text means,
 * and what a value picked into it becomes. Every way a value arrives (a click
 * in "Comes in", a drop, the field's own {} picker, a clicked pill, the
 * autocomplete) goes through `pickedBinding`, so they can no longer disagree
 * about whether a list is asked about.
 */

export type Mode = 'fixed' | 'expression';

type Binding = { kind: 'ref'; path: string } | { kind: 'expr'; value: string } | { kind: 'template'; value: string };

// `{{ x }}` alone. The inner text is trimmed in code, not by the pattern: a
// `\s*` on both sides of a lazy `[^}]+?` backtracks cubically over a run of
// spaces (`{{` and 2000 spaces froze the field).
const LONE_TEMPLATE_RE = /^\s*\{\{([^}]*)\}\}\s*$/;
// One of the calls a picked list is written as: `join(p, "\n")`, `first(p)`.
// Only the head and the separator are patterns (loneCallArg does the rest):
// as one regex, the optional separator between `\s*` runs backtracked
// exponentially on `first(` and a few hundred spaces.
const LONE_CALL_HEAD_RE = /^\s*(?:first|last|count|join)\(/;
const CALL_SEPARATOR_RE = /^,\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/;

/** The reference inside a lone `{{ x }}`, or null (an empty `{{ }}` names nothing). */
function loneTemplateRef(s: string): string | null {
    const m = LONE_TEMPLATE_RE.exec(s);
    return m ? m[1].trim() || null : null;
}

/** The first argument of a lone `first(p)` / `join(p, "\n")` call, or null. */
function loneCallArg(s: string): string | null {
    const head = LONE_CALL_HEAD_RE.exec(s);
    if (!head) return null;
    const rest = s.slice(head[0].length).trimEnd();
    if (!rest.endsWith(')')) return null;
    const args = rest.slice(0, -1).trimEnd();
    const end = args.search(/[,()]/);
    const arg = (end === -1 ? args : args.slice(0, end)).trim();
    if (!arg) return null;
    return end === -1 || CALL_SEPARATOR_RE.test(args.slice(end)) ? arg : null;
}

/**
 * Does the text hold ONE picked value: a reference, or a reference in the
 * call a picked list was written as? In Formula mode a newly picked value
 * then replaces it (the way a chip is replaced) instead of being glued onto
 * it: two bare paths side by side serialised as
 * `steps.a.output.xsteps.b.output.y`, which was stored as one bogus ref. In
 * Text mode only a re-picked pill replaces it (BindingField.acceptPath): two
 * `{{ }}` side by side are a valid template.
 */
export function isLoneRef(text: string, mode: Mode): boolean {
    const s = String(text ?? '');
    if (mode === 'expression') {
        return bindingFromInput(loneCallArg(s) ?? s, 'expression').kind === 'ref';
    }
    const ref = loneTemplateRef(s);
    return !!ref && !!classifyRef(ref);
}

const MANY = new Set(['list', 'table']);

/**
 * The binding a picked value makes of the WHOLE field. A list or a table
 * gets what the core's defaultIntent says the field wants of it ("all, one
 * per line" for text, "the first" for a number), written in the legacy
 * spelling this editor holds (`join(p, "\n")`, `first(p)`); a single value,
 * or a list the field takes as it is, is the reference itself.
 */
export function pickedBinding(
    path: string,
    { mode, slot, sample, source, shapeHint }: {
        mode: Mode;
        slot: Slot;
        sample: object | null | undefined;
        source?: Source | MappingSource | null;
        shapeHint?: string | null;
    },
): Binding {
    // A column's Source has a WILD (dropped here); the clicked path keeps its
    // [*] in what is written, where the sample cannot show the list.
    const from = pickableSource(source) || sourceFromPath(path);
    if (from) {
        const shape = shapeAt(from, sample, shapeHint);
        if (MANY.has(shape)) {
            const { warning: _warning, ...intent } = defaultIntent(shape, slot);
            const asItIs = intent.take === 'one' || (intent.take === 'all' && intent.as !== 'text');
            const lowered = asItIs ? null : lowerPick(makePick(from, intent), sample, path);
            if (lowered) return lowered;
        }
    }
    return mode === 'fixed' ? { kind: 'template', value: `{{${path}}}` } : { kind: 'ref', path };
}

/**
 * Rewrite the field text when the user flips the mode switch, for the one
 * shape both modes can express: a single reference.
 *   text  -> expression:  `{{ steps.a.output.x }}`  ->  `steps.a.output.x`
 *   expression -> text:   `steps.a.output.x`        ->  `{{steps.a.output.x}}`
 * Everything else (mixed templates, computed expressions) is returned as-is.
 */
export function translateForMode(text: string, nextMode: Mode): string {
    const s = String(text ?? '');
    if (nextMode === 'expression') {
        return loneTemplateRef(s) ?? s;
    }
    const bare = s.trim();
    if (!bare || TEMPLATE_RE.test(s)) return s;
    const root = bare.split(/[.[]/)[0];
    const single = isCleanPath(bare) || bindingFromInput(bare, 'expression').kind === 'ref';
    return single && WRAPPABLE_ROOTS.has(root) ? `{{${bare}}}` : s;
}

// Roots whose values a `{{ }}` interpolation can reach at run time. `item` and
// `_index` are the per-row scope of a list-mode Edit data step.
const WRAPPABLE_ROOTS = new Set(['trigger', 'steps', 'vars', 'secrets', 'loop', 'item', '_index']);

/**
 * Structural equality for two binding objects. Used to recognise the parent
 * echoing back the value this field just emitted, so the sync effect doesn't
 * clobber the user's chosen mode. Bindings are small, JSON-shaped, and key
 * order is fixed by `bindingFromInput`, so a stringify comparison is both
 * correct and cheap here.
 */
export function sameBinding(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}
