import type { EditorField } from './fieldEditor.types';

/**
 * What each kind of question can carry. Plain data and pure functions, so the
 * editors (which are components) and the card that switches a question's type
 * agree on one list. Mirrors the server (automation/formFieldRules.js,
 * formDynamicFields.js, formFieldTypes.js).
 */

/** Question types that offer a list of choices. */
export const CHOICE_TYPES = ['select', 'radio', 'multiselect'];

/** The question types that can carry answer rules (several-choices bounds live with the choices). */
export const RULE_TYPES = ['number', 'date', 'text', 'textarea', 'email'];

/** The rule keys a type of question may carry. */
export const RULE_KEYS_BY_TYPE: Record<string, string[]> = {
    number: ['min', 'max'],
    date: ['min', 'max'],
    text: ['minLength', 'maxLength', 'pattern', 'patternMessage'],
    textarea: ['minLength', 'maxLength', 'pattern', 'patternMessage'],
    email: ['minLength', 'maxLength'],
    multiselect: ['minSelected', 'maxSelected'],
};

const ALL_RULE_KEYS = [...new Set(Object.values(RULE_KEYS_BY_TYPE).flat())];

/** Does this question carry any rule? (decides whether the section starts open) */
export const hasRules = (f: EditorField): boolean => (RULE_KEYS_BY_TYPE[f.type || 'text'] || []).some(k => f[k] !== undefined && f[k] !== null && f[k] !== '');

/**
 * The changes that clear every rule key the new type does not use. A rule left
 * on a question after its type changed (a `min` on what is now a text box)
 * would be refused by the server, and would be invisible in the editor.
 */
export function clearStaleRules(nextType: string): Record<string, undefined> {
    const keep = new Set(RULE_KEYS_BY_TYPE[nextType] || []);
    return Object.fromEntries(ALL_RULE_KEYS.filter(k => !keep.has(k)).map(k => [k, undefined]));
}

/** The question types that can be asked once per item (server FIELDS_FROM_TYPES). */
export const PER_ITEM_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'radio', 'checkbox'];
/** The longest binding name such a question may have (server MAX_FIELDS_FROM_NAME_LEN). */
export const PER_ITEM_NAME_MAX = 54;

/** Can this question be asked once per item of a list? */
export const canAskPerItem = (f: EditorField): boolean => PER_ITEM_TYPES.includes(f.type || 'text') && !f.optionsFrom;

/** The most characters an authored text block may hold (server MAX_INFO_LEN). */
export const INFO_MAX_LEN = 4000;

/**
 * Everything that must change when a question's type changes: the new type,
 * together with the removal of settings it does not use. A rule left on a
 * question whose type no longer has it is refused by the server and is
 * invisible in the editor.
 */
export function typeChangePatch(field: EditorField, nextType: string): Partial<EditorField> {
    const patch: Partial<EditorField> = { type: nextType, ...clearStaleRules(nextType) };
    if (!CHOICE_TYPES.includes(nextType)) patch.optionsFrom = undefined;
    if (!PER_ITEM_TYPES.includes(nextType)) patch.fieldsFrom = undefined;
    if (nextType === 'info') {
        patch.required = false;
        if (field.content === undefined) patch.content = '';
    }
    return patch;
}
