/**
 * Input bindings and user-named field maps: converting a binding between
 * kinds, and dropping the half-edited rows a save must not persist.
 */
import type { FormRecord } from './types';

/** Move the previous binding's value into the new shape so the user
 *  doesn't lose what they typed when toggling kind. */
export function convertValue(binding: FormRecord | null | undefined, fromKind: string, toKind: string): FormRecord {
    if (!binding) return {};
    if (fromKind === toKind) return {};
    const carry = binding.value ?? binding.path ?? '';
    if (toKind === 'literal')  return { value: typeof carry === 'string' ? carry : String(carry), path: undefined };
    if (toKind === 'ref')      return { path: typeof carry === 'string' ? carry : '', value: undefined };
    if (toKind === 'template') return { value: typeof carry === 'string' ? carry : '', path: undefined };
    if (toKind === 'expr')     return { value: typeof carry === 'string' ? carry : '', path: undefined };
    return {};
}

/** Drop bindings that have neither a value nor a path so we don't
 *  persist a half-edited row that fails validation. */
export function sanitizeInputs(inputs: FormRecord): FormRecord {
    const out: FormRecord = {};
    for (const [k, v] of Object.entries(inputs || {})) {
        if (!v || typeof v !== 'object') continue;
        if (v.kind === 'literal' && (v.value === '' || v.value == null)) continue;
        if (v.kind === 'ref' && !v.path) continue;
        if ((v.kind === 'template' || v.kind === 'expr') && !v.value) continue;
        out[k] = v;
    }
    return out;
}

/**
 * Sanitize a USER-DEFINED field map (Set / layer_output return). Unlike
 * sanitizeInputs — which is for tool PARAMS, where an empty value means
 * "omit this param" — the keys here are the user's OWN named fields. A field
 * the user just added but hasn't given a value yet MUST survive the save
 * round-trip; otherwise the autosave strips it and the form re-hydrates
 * without the row, so it vanishes mid-edit. We therefore keep every entry
 * with a non-empty key and a binding object, regardless of an empty value;
 * only blank-key / non-object entries are dropped.
 */
export function sanitizeFieldMap(fields: FormRecord): FormRecord {
    const out: FormRecord = {};
    for (const [k, v] of Object.entries(fields || {})) {
        if (!k || !k.trim()) continue;
        if (v == null) continue;
        // Bare (non-object) literals are LEGAL — bind.js resolves them as
        // literal values, and API/import/legacy definitions carry them.
        // Dropping them here silently emptied `fields` on the first unrelated
        // edit (C15); normalise to the canonical wrapper instead so the UI
        // can edit them.
        if (typeof v !== 'object') { out[k] = { kind: 'literal', value: v }; continue; }
        out[k] = v;
    }
    return out;
}
