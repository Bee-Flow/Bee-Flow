import { evaluate } from '@shared/expr/index.mjs';
import * as parse from '@shared/expr/parse.mjs';
import { createResolver, inlineText, renderText } from '@shared/mapping/index.mjs';
import { previewValue } from '../../../../utils/bindingHelpers';

/**
 * Resolve the "example" line for a binding against a sample root tree
 * (design-time samples merged with real-run/pinned data by the inspector).
 *
 * Every kind is resolved by the shared core the run uses (createResolver,
 * with the shared expression engine and readers), never by a second walker
 * here: literal, ref, template, expr, and the v2 pick and compose the AI
 * builder writes. So the example is what the run would give on that data.
 *
 *   - literal   — the value itself, formatted
 *   - ref       — the sample found at that path
 *   - template  — the text with every `{{path}}` substituted
 *   - expr      — the expression EVALUATED by the shared deterministic engine
 *   - pick      — the value the pick selects, a list or a record as text
 *   - compose   — the text with its values in it
 *
 * Returns null when there is nothing worth showing. `raw` decides what to do
 * when a binding can't be resolved: BindingField (whose user is already
 * looking at the source) falls back to the path or the expression; a caller
 * that shows values to people passes `raw: false` and shows nothing rather
 * than leaking a path with an internal step id in it.
 */

// Counts the `{{ }}` of a template that found nothing on the sample. The
// resolver is synchronous, so a counter reset before each template is exact.
let templateMisses = 0;
const resolver = createResolver({ evaluate, parse, onUnresolved: () => { templateMisses += 1; } });

const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/** The sample as the run would see it from a user-visible field: no secrets, no warning sink. */
function safeSample(sampleRoot) {
    const { _templateWarnings: _ignored, ...rest } = sampleRoot;
    return { ...rest, secrets: {} };
}

/** What the binding gives on the sample, or undefined (never a throw). */
function resolveOnSample(binding, sampleRoot) {
    if (!sampleRoot) return undefined;
    try {
        return resolver.resolveValue(binding, safeSample(sampleRoot), { silent: true });
    } catch {
        return undefined;
    }
}

/** A v2 value as one line of text, the way a list or a record reads in a field. */
function v2Text(value) {
    if (value === undefined) return null;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return inlineText(value);
    if (value !== null && typeof value === 'object') return renderText(value, { join: 'comma' });
    return value === null ? '' : String(value);
}

/** The template with its `{{ }}` filled from the sample, as the run fills it. */
function previewTemplate(text, sampleRoot, raw) {
    const tokens = (String(text).match(TOKEN_RE) || []).length;
    templateMisses = 0;
    let filled;
    try {
        filled = resolver.interpolateTemplate(text, safeSample(sampleRoot), { leaveUnresolved: raw });
    } catch {
        return raw ? previewValue(String(text), 60) : null;
    }
    if (!raw && tokens > 0 && templateMisses >= tokens) return null;
    return previewValue(filled, 60);
}

export default function previewBinding(binding, sampleRoot, { raw = true } = {}) {
    if (!binding) return null;
    if (binding.kind === 'literal') {
        if (binding.value == null || binding.value === '') return null;
        return previewValue(binding.value, 60);
    }
    if (binding.kind === 'ref') {
        if (!binding.path) return null;
        if (!sampleRoot) return raw ? binding.path : null;
        const v = resolveOnSample(binding, sampleRoot);
        if (v === undefined) return raw ? `(no sample for ${binding.path})` : null;
        return previewValue(v, 60);
    }
    if (binding.kind === 'template') {
        if (!binding.value) return null;
        if (!sampleRoot) return raw ? binding.value : null;
        return previewTemplate(binding.value, sampleRoot, raw);
    }
    if (binding.kind === 'expr') {
        if (!binding.value) return null;
        const v = resolveOnSample(binding, sampleRoot);
        if (v !== undefined) return previewValue(v, 60);
        return raw ? `expr: ${binding.value}` : null;
    }
    if (binding.kind === 'pick' || binding.kind === 'compose') {
        const text = v2Text(resolveOnSample(binding, sampleRoot));
        return text ? previewValue(text, 60) : null;
    }
    return null;
}

/**
 * The SHAPE a binding resolves to — the honesty layer under the example line.
 * `previewBinding` renders "[2 items]" for a list, which reads like a value;
 * this sibling answers "is it a list, how many, is it empty" so the field can
 * warn instead of implying success. Resolves through the SAME shared resolver
 * as the string preview — never a second resolver.
 *
 * Returns { isList, count, empty, first } or null (unresolvable / no sample).
 */
export function previewBindingShape(binding, sampleRoot) {
    if (!binding || !sampleRoot) return null;
    if (binding.kind === 'ref') {
        if (!binding.path) return null;
    } else if (binding.kind === 'expr') {
        if (!binding.value) return null;
    } else if (binding.kind !== 'pick') {
        return null; // literals, templates and composes always resolve to text
    }
    const v = resolveOnSample(binding, sampleRoot);
    if (v === undefined) return null;
    if (!Array.isArray(v)) return { isList: false, count: null, empty: false, first: v };
    return { isList: true, count: v.length, empty: v.length === 0, first: v[0] };
}
