import type { ModelField } from './tablesManagerModel';

/**
 * The optional field rules of a data-model field, as the table editor edits
 * them: `field.validation` and `field.dynamicDefault`. The server checks both
 * on every write (core/dataEngine/fieldRules.mts) and refuses a model whose
 * rules do not fit the field type (fieldRuleErrors); this copy of the per-type
 * lists is pinned to the server vocabulary by fieldRules.vocabulary.test.ts.
 *
 * Every helper returns a NEW field and removes a key instead of writing it
 * empty, so a field nobody gave a rule keeps exactly the bytes it had.
 */

export interface FieldValidation {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    enforceOptions?: boolean;
    message?: string;
}

export type RuleKey = keyof FieldValidation;

/** Which rules apply to a field type ('message' applies whenever another rule is set). */
export const RULES_BY_TYPE: Readonly<Record<string, readonly RuleKey[]>> = {
    number: ['min', 'max'],
    text: ['minLength', 'maxLength', 'pattern'],
    select: ['enforceOptions'],
    multiselect: ['enforceOptions'],
};

/** The dynamic default a field type can take. */
export const DYNAMIC_DEFAULT_BY_TYPE: Readonly<Record<string, string>> = {
    datetime: 'now',
    date: 'today',
    text: 'currentUser.id',
};

const isEmptyRule = (v: unknown): boolean => v === undefined || v === null || v === '' || v === false;

export function validationOf(field: ModelField): FieldValidation {
    const v = field.validation;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as FieldValidation : {};
}

/** The field with one rule set, or removed when the value is empty; `validation` goes when nothing is left. */
export function withRule<K extends RuleKey>(field: ModelField, key: K, value: FieldValidation[K] | null): ModelField {
    const next: FieldValidation = { ...validationOf(field) };
    if (isEmptyRule(value)) delete next[key];
    else next[key] = value as FieldValidation[K];
    const { validation: _old, ...rest } = field;
    const keys = Object.keys(next).filter((k) => k !== 'message');
    // A message alone checks nothing: it goes with the last rule.
    return keys.length ? { ...rest, validation: next } : rest;
}

/** The field with a dynamic default, or without one (null). Setting one drops the static default: the server keeps one of the two. */
export function withDynamicDefault(field: ModelField, value: string | null): ModelField {
    const { dynamicDefault: _old, ...rest } = field;
    if (!value) return rest;
    const { default: _static, ...withoutStatic } = rest;
    return { ...withoutStatic, dynamicDefault: value };
}

/** A type change: the rules of the old type do not apply to the new one. */
export function withoutRules(field: ModelField): ModelField {
    const { validation: _v, dynamicDefault: _d, ...rest } = field;
    return rest;
}
