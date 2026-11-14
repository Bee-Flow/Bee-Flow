// @typecheck strict
/**
 * The data-loss guard of a datatable draft (datatableDraft.js explains the
 * three layers): a current column the draft left out is put back at its
 * place, and the summary of what the draft changes is what the panel shows
 * before anyone saves. Pure.
 */

'use strict';

/**
 * A column of the table as it is now, and one of the draft.
 * @typedef {{ key: string, id?: string, name?: string, type?: string, required?: boolean, unique?: boolean, options?: unknown }} CurrentField
 * @typedef {{ key: string, name: string, type: string, options?: string[], required?: boolean, unique?: boolean }} DraftField
 */

/** @param {{ options?: unknown } | null | undefined} field */
function optionValues(field) {
    return Array.isArray(field?.options)
        ? field.options.map(o => (typeof o === 'string' ? o : o?.value ?? o?.label)).filter(v => typeof v === 'string' && v)
        : [];
}

const isList = (/** @type {string} */ type) => type === 'select' || type === 'multiselect';

/**
 * Guard: a current column the model left out comes back, at its place —
 * right after the nearest column that precedes it today and is in the draft,
 * else at the front.
 * @param {CurrentField[]} before
 * @param {DraftField[]} fields
 * @param {Set<string>} taken   the keys in the draft; the restored ones are added
 * @param {string[]} notes
 */
function restoreLeftOut(before, fields, taken, notes) {
    const missing = before.filter(f => !taken.has(f.key));
    for (const f of missing) {
        const idx = before.indexOf(f);
        let at = 0;
        for (let i = idx - 1; i >= 0; i -= 1) {
            const pos = fields.findIndex(x => x.key === before[i].key);
            if (pos >= 0) { at = pos + 1; break; }
        }
        /** @type {DraftField} */
        const kept = { key: f.key, name: f.name || f.key, type: /** @type {string} */ (f.type) };
        if (isList(/** @type {string} */ (f.type))) kept.options = optionValues(f);
        if (f.required === true) kept.required = true;
        if (f.unique === true) kept.unique = true;
        fields.splice(at, 0, kept);
        taken.add(f.key);
    }
    if (missing.length) notes.push(`Kept ${missing.length === 1 ? 'a column' : `${missing.length} columns`} the draft left out (${missing.map(f => f.name || f.key).join(', ')}) — removing is off.`);
}

/**
 * What the draft changes against the table now: added, renamed, retyped, removed.
 * @param {DraftField[]} fields
 * @param {CurrentField[]} before
 * @param {Map<string, CurrentField>} byKey
 */
function draftChanges(fields, before, byKey) {
    const was = (/** @type {DraftField} */ f) => /** @type {CurrentField} */ (byKey.get(f.key));
    const after = new Map(fields.map(f => [f.key, f]));
    return {
        added: fields.filter(f => !byKey.has(f.key)).map(f => f.key),
        renamed: fields.filter(f => byKey.has(f.key) && (was(f).name || f.key) !== f.name).map(f => ({ key: f.key, from: was(f).name || f.key, to: f.name })),
        retyped: fields.filter(f => byKey.has(f.key) && was(f).type !== f.type).map(f => ({ key: f.key, from: was(f).type, to: f.type })),
        removed: before.filter(f => !after.has(f.key)).map(f => f.key),
    };
}

module.exports = { isList, optionValues, restoreLeftOut, draftChanges };
