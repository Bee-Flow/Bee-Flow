import { tryEvaluate } from '@shared/expr/engine.mjs';
import { replaceTemplate } from '@shared/expr/path.mjs';
import { isScalarList, templateText } from '@shared/expr/templateText.mjs';
import { walkPath, previewValue } from '../../../../utils/bindingHelpers';

/**
 * Resolve the "example" line for a binding against a sample root tree
 * (design-time samples merged with real-run/pinned data by the inspector):
 *
 *   - literal   — the value itself, formatted
 *   - ref       — the sample found at that path
 *   - template  — the text with every `{{path}}` substituted
 *   - expr      — the expression EVALUATED by the shared deterministic engine
 *                 (@shared/expr: pure, whitelisted functions, no JS sandbox),
 *                 so `lower(item.email)` and `parseJson(item.body, "total")`
 *                 show a real value instead of jargon.
 *
 * Returns null when there is nothing worth showing. `raw` decides what to do
 * when an expression can't be evaluated: BindingField (whose user is already
 * looking at the expression source) falls back to `expr: <source>`; the visual
 * ValueBuilder passes `raw: false` and shows nothing rather than leaking a
 * path with an internal step id in it.
 *
 * `listAs` is how the slot's RUN writes a list or a record into text
 * (server/automation/bind.js interpolateTemplate): 'text' (the default) reads
 * "red, green, blue" and "name: Ann, city: Utrecht"; 'json' — tool, AI, code
 * and table inputs, which carry data — writes JSON. The template preview
 * renders every value through the runtime's own templateText with that
 * setting, so the example line says what the step will receive.
 *
 * A list of plain values reads as its values ("a@x.nl, b@x.nl") in a ref's
 * example too — the "list of 2" badge beside it says it is a list. `maxLen`
 * is how much text the line may hold (the visual editor wraps it).
 */
export default function previewBinding(binding, sampleRoot, { raw = true, listAs = 'text', maxLen = 60 } = {}) {
    if (!binding) return null;
    if (binding.kind === 'literal') {
        if (binding.value == null || binding.value === '') return null;
        return previewValue(binding.value, maxLen);
    }
    if (binding.kind === 'ref') return previewRef(binding.path, sampleRoot, { raw, listAs, maxLen });
    if (binding.kind === 'template') {
        if (!binding.value) return null;
        if (!sampleRoot) return raw ? binding.value : null;
        let resolvedAny = false;
        const lists = listAs === 'json' ? 'json' : 'join';
        // The runtime's placeholder scan, walker and text rendering — the
        // three things interpolateTemplate does — so nothing here can show a
        // value, or a shape of a value, the run would not write.
        const filled = replaceTemplate(String(binding.value), (inner, full) => {
            const v = walkPath(inner, sampleRoot);
            if (v === undefined) return raw ? full : '…';
            resolvedAny = true;
            return templateText(v, { lists }).replace(/\n/g, ' · ');
        });
        if (!raw && !resolvedAny) return null;
        return previewValue(filled, maxLen);
    }
    if (binding.kind === 'expr') {
        if (!binding.value) return null;
        if (sampleRoot) {
            const { value, error } = tryEvaluate(binding.value, sampleRoot);
            if (!error && value !== undefined) return previewValue(value, maxLen);
        }
        return raw ? `expr: ${binding.value}` : null;
    }
    return null;
}

/** A ref's sample; a list of plain values reads as its values ("a, b"). */
function previewRef(path, sampleRoot, { raw, listAs, maxLen }) {
    if (!path) return null;
    if (!sampleRoot) return raw ? path : null;
    const v = walkPath(path, sampleRoot);
    if (v === undefined) return raw ? `(no sample for ${path})` : null;
    if (isScalarList(v) && v.length) return previewValue(templateText(v, { lists: listAs === 'json' ? 'json' : 'join' }), maxLen);
    return previewValue(v, maxLen);
}

/**
 * The SHAPE a binding resolves to — the honesty layer under the example line.
 * `previewBinding` renders "[2 items]" for a list, which reads like a value;
 * this sibling answers "is it a list, how many, is it empty" so the field can
 * warn instead of implying success. Resolves through the SAME walkPath /
 * tryEvaluate as the string preview — never a second resolver.
 *
 * Returns { isList, count, empty, first } or null (unresolvable / no sample).
 */
export function previewBindingShape(binding, sampleRoot) {
    if (!binding || !sampleRoot) return null;
    let v;
    if (binding.kind === 'ref') {
        if (!binding.path) return null;
        v = walkPath(binding.path, sampleRoot);
    } else if (binding.kind === 'expr') {
        if (!binding.value) return null;
        const { value, error } = tryEvaluate(binding.value, sampleRoot);
        if (error) return null;
        v = value;
    } else {
        return null; // literals and templates always resolve to text
    }
    if (v === undefined) return null;
    if (!Array.isArray(v)) return { isList: false, count: null, empty: false, first: v };
    return { isList: true, count: v.length, empty: v.length === 0, first: v[0] };
}
