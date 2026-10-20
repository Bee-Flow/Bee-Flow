import { tryEvaluate } from '@shared/expr/engine.mjs';
import type { TranslateFn } from '../../hooks/useTranslation';
import type { FormFieldDef, FormValue, FormValues } from './PublicFormRenderer.types';

/**
 * The pure half of the public form: which questions are on screen, what a
 * blank answer is, which rule an answer breaks, and what is sent.
 *
 * Everything here MIRRORS the server (automation/formFieldTypes.js,
 * formFieldRules.js, formCoerce.js), which stays the authority: this only
 * saves the visitor a round trip. Where the two could disagree, this errs
 * towards letting the answer through.
 */

// Display-only field types: they show something instead of collecting it, so
// they get no entry in `values` and are skipped by every check. Mirrors the
// server's DISPLAY_FIELD_TYPES.
export const DISPLAY_FIELD_TYPES: ReadonlyArray<string | undefined> = ['download', 'notebook', 'info'];
export const isDisplayField = (f: FormFieldDef | null | undefined): boolean => DISPLAY_FIELD_TYPES.includes(f?.type);

/** What an unanswered question holds. Mirrors the server's emptyValue(). */
export function emptyValue(f: FormFieldDef): FormValue {
    if (f.type === 'checkbox') return false;
    if (f.type === 'file') return null;
    if (f.type === 'app_pick') return f.multiple ? [] : null;
    if (f.type === 'multiselect') return [];
    return '';
}

/**
 * The form's key set with every answer empty — the shape a submission has
 * before anyone types anything.
 *
 * Exported (BFSF-408b) because it is also the free answer to "what does this
 * trigger hand my next step?": the automation builder seeds an edited trigger
 * payload from it, so the author sees every declared key without filling the
 * form in. Deliberately the SAME function the renderer seeds its own state
 * with — a second generator would drift from the real submission shape.
 */
export function initialValues(fields: FormFieldDef[] | null | undefined): FormValues {
    const out: FormValues = {};
    for (const f of (Array.isArray(fields) ? fields : [])) {
        if (isDisplayField(f)) continue;
        out[f.name] = emptyValue(f);
    }
    return out;
}

export function isBlank(field: FormFieldDef, value: FormValue): boolean {
    if (field.type === 'checkbox') return value !== true;
    if (field.type === 'file') return !value;
    if (field.type === 'app_pick' || field.type === 'multiselect') return Array.isArray(value) ? value.length === 0 : !value;
    return value === undefined || value === null || String(value).trim() === '';
}

// ── Visibility ─────────────────────────────────────────

/** The value a later showIf reads for an answer, shaped like the server's coerced value. */
function scopeValue(f: FormFieldDef, value: FormValue): unknown {
    if (value === undefined || value === null) return emptyValue(f);
    if (f.type === 'number') {
        const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
        return Number.isFinite(n) ? n : '';
    }
    if (typeof value === 'string' && f.type !== 'text' && f.type !== 'textarea') return value.trim();
    return value;
}

/** A showIf that cannot be evaluated FAILS OPEN: a broken condition must never hide a question. */
function isShown(showIf: string | undefined, scope: Record<string, unknown>): boolean {
    if (typeof showIf !== 'string' || !showIf.trim()) return true;
    const { value, error } = tryEvaluate(showIf, { form: scope });
    return error ? true : !!value;
}

/**
 * The names of the fields that are on screen, decided in declaration order:
 * a field sees only the answers of the questions ABOVE it, and a hidden
 * question counts as its empty value, so a chain of conditions unwinds the
 * same way the server unwinds it. A group's items are also readable as one
 * list under the group's name, like the folded answer the server builds.
 */
export function visibleNames(fields: FormFieldDef[], values: FormValues): Set<string> {
    const visible = new Set<string>();
    const scope: Record<string, unknown> = Object.create(null);
    for (const f of fields) {
        if (f.groupHeader && f.group) scope[f.group] = [];
        const shown = isShown(f.showIf, scope);
        if (shown) visible.add(f.name);
        if (isDisplayField(f)) continue;
        const v = shown ? scopeValue(f, values[f.name]) : emptyValue(f);
        scope[f.name] = v;
        if (f.group) {
            if (!Array.isArray(scope[f.group])) scope[f.group] = [];
            (scope[f.group] as unknown[]).push({ key: f.groupKey ?? '', label: f.label, answer: v });
        }
    }
    return visible;
}

// ── Layout ─────────────────────────────────────────────

/** What the page draws: a lone field, or a header with its questions grouped under it. */
export type FormBlock =
    | { kind: 'field'; field: FormFieldDef }
    | { kind: 'group'; group: string; header: FormFieldDef | null; items: FormFieldDef[] };

/**
 * The visible fields as blocks. A group is the "one question per list item"
 * expansion: its header and items are neighbours in `fields`. A group with no
 * visible item (an empty list, or every item hidden) is dropped, so a bare
 * sub-heading never hangs over nothing.
 */
export function groupBlocks(fields: FormFieldDef[], visible: Set<string>): FormBlock[] {
    const out: FormBlock[] = [];
    for (const f of fields) {
        if (!visible.has(f.name)) continue;
        if (!f.group) { out.push({ kind: 'field', field: f }); continue; }
        const last = out[out.length - 1];
        let block: Extract<FormBlock, { kind: 'group' }>;
        if (last && last.kind === 'group' && last.group === f.group) {
            block = last;
        } else {
            block = { kind: 'group', group: f.group, header: null, items: [] };
            out.push(block);
        }
        if (f.groupHeader) block.header = f;
        else block.items.push(f);
    }
    return out.filter(b => b.kind === 'field' || b.items.length > 0);
}

// ── Rules ──────────────────────────────────────────────

const PATTERN_CACHE_MAX = 100;
const patternCache = new Map<string, RegExp | null>();
// A nested quantifier such as (a+)+ can freeze a browser tab on a short input.
// The server matches with a linear-time engine, so it is safe there; here such
// a pattern is skipped and the server judges the answer.
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)[+*{]/;

/** The author's pattern for a WHOLE-value match, or null when this browser cannot run it. */
function compilePattern(pattern: string): RegExp | null {
    if (patternCache.has(pattern)) return patternCache.get(pattern) ?? null;
    let re: RegExp | null = null;
    if (pattern.length <= 200 && !NESTED_QUANTIFIER.test(pattern)) {
        try {
            // On its own first: wrapped, an unbalanced `a)|(b` would still compile.
            void new RegExp(pattern, 'u');
            re = new RegExp(`^(?:${pattern})$`, 'u');
        } catch {
            re = null;
        }
    }
    if (patternCache.size >= PATTERN_CACHE_MAX) patternCache.delete(patternCache.keys().next().value as string);
    patternCache.set(pattern, re);
    return re;
}

const asNumber = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
};

const label = (f: FormFieldDef): string => f.label || f.name;

type RuleCheck = (field: FormFieldDef, value: FormValue, t: TranslateFn) => string | null;

const numberRule: RuleCheck = (field, value, t) => {
    const n = asNumber(value);
    const lo = asNumber(field.min);
    const hi = asNumber(field.max);
    if (n === null) return null;
    if (lo !== null && n < lo) return t('forms.rule.min', '{label} must be at least {n}.', { label: label(field), n: lo });
    if (hi !== null && n > hi) return t('forms.rule.max', '{label} must be at most {n}.', { label: label(field), n: hi });
    return null;
};

const dateRule: RuleCheck = (field, value, t) => {
    if (typeof value !== 'string') return null;
    if (typeof field.min === 'string' && field.min && value < field.min) return t('forms.rule.date_min', '{label} must be on or after {date}.', { label: label(field), date: field.min });
    if (typeof field.max === 'string' && field.max && value > field.max) return t('forms.rule.date_max', '{label} must be on or before {date}.', { label: label(field), date: field.max });
    return null;
};

const selectedRule: RuleCheck = (field, value, t) => {
    if (!Array.isArray(value)) return null;
    const { minSelected: lo, maxSelected: hi } = field;
    const l = label(field);
    if (typeof lo === 'number' && value.length < lo) {
        return lo === 1
            ? t('forms.rule.min_selected_one', '{label} must have at least 1 choice.', { label: l })
            : t('forms.rule.min_selected', '{label} must have at least {n} choices.', { label: l, n: lo });
    }
    if (typeof hi === 'number' && value.length > hi) {
        return hi === 1
            ? t('forms.rule.max_selected_one', '{label} must have at most 1 choice.', { label: l })
            : t('forms.rule.max_selected', '{label} must have at most {n} choices.', { label: l, n: hi });
    }
    return null;
};

const textRule: RuleCheck = (field, value, t) => {
    if (typeof value !== 'string') return null;
    const l = label(field);
    const len = [...value].length;
    if (typeof field.minLength === 'number' && len < field.minLength) return t('forms.rule.min_length', '{label} must be at least {n} characters.', { label: l, n: field.minLength });
    if (typeof field.maxLength === 'number' && len > field.maxLength) return t('forms.rule.max_length', '{label} must be at most {n} characters.', { label: l, n: field.maxLength });
    const re = field.pattern && field.type !== 'email' ? compilePattern(field.pattern) : null;
    // A pattern this browser cannot run is not the visitor's problem: the server decides.
    if (re && !re.test(value)) return field.patternMessage || t('forms.rule.pattern', '{label} is not in the expected format.', { label: l });
    return null;
};

const RULES: Record<string, RuleCheck> = {
    number: numberRule,
    date: dateRule,
    multiselect: selectedRule,
    text: textRule,
    textarea: textRule,
    email: textRule,
};

/**
 * The first rule a non-blank answer breaks, as a localized sentence, or null.
 * A blank answer is never judged here: "is it required" is a separate question.
 */
export function ruleError(field: FormFieldDef, value: FormValue, t: TranslateFn): string | null {
    if (isBlank(field, value)) return null;
    return Object.hasOwn(RULES, field.type) ? RULES[field.type](field, value, t) : null;
}

/** "Required" first, then the rules: the one message a question shows, or null. */
export function fieldError(field: FormFieldDef, value: FormValue, t: TranslateFn, { checkRequired = true } = {}): string | null {
    if (isDisplayField(field)) return null;
    if (isBlank(field, value)) {
        // A run-data list that came back empty cannot be answered, so it never blocks.
        return checkRequired && field.required && !field.noOptions ? t('forms.required', '{label} is required.', { label: label(field) }) : null;
    }
    return ruleError(field, value, t);
}

/** Every message a submit would be refused with, by field name: visible questions only. */
export function collectErrors(fields: FormFieldDef[], values: FormValues, visible: Set<string>, t: TranslateFn): Record<string, string> {
    const found: Record<string, string> = {};
    for (const f of fields) {
        if (isDisplayField(f) || !visible.has(f.name)) continue;
        const message = fieldError(f, values[f.name], t);
        if (message) found[f.name] = message;
    }
    return found;
}

// ── Submission ─────────────────────────────────────────

/** The body: answers of the questions on screen only. Hidden and display-only fields are left out. */
export function submissionValues(fields: FormFieldDef[], values: FormValues, visible: Set<string>): FormValues {
    const out: FormValues = {};
    for (const f of fields) {
        if (isDisplayField(f) || !visible.has(f.name)) continue;
        out[f.name] = values[f.name];
    }
    return out;
}

// ── Typical duration ───────────────────────────────────

/** "Usually takes about 2 minutes" under the progress line, or '' when the length is unknown. */
export function typicalDurationText(seconds: number | null | undefined, t: TranslateFn): string {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 1) return '';
    if (seconds < 60) return t('forms.typical.under_minute', 'Usually takes less than a minute');
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) {
        return minutes === 1
            ? t('forms.typical.minute', 'Usually takes about 1 minute')
            : t('forms.typical.minutes', 'Usually takes about {n} minutes', { n: minutes });
    }
    const hours = Math.round(minutes / 60);
    return hours === 1
        ? t('forms.typical.hour', 'Usually takes about 1 hour')
        : t('forms.typical.hours', 'Usually takes about {n} hours', { n: hours });
}
