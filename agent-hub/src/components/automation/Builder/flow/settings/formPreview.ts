import { getList, getRelativePath } from '@shared/expr/path.mjs';
import { walkPath, previewValue } from '../../../../../utils/bindingHelpers';
import { normaliseOptions, type FormOption } from '../../../../forms/formOptions';

/**
 * What the form's live preview renders, as a pure function of the declaration.
 *
 * The preview is the visitor's view, and the visitor never sees `{{…}}`: the
 * server interpolates at the moment the page is shown. So resolve the same way
 * here, against the builder's sample tree.
 */

type Loose = Record<string, unknown>;

/** Field types that GIVE instead of ask (mirrors DISPLAY_FIELD_TYPES on the server). */
export const DISPLAY_FIELD_TYPES = ['download', 'notebook', 'info'];
/** The display fields that point at a file (mirrors FILE_FIELD_TYPES on the server). */
export const FILE_FIELD_TYPES = ['download', 'notebook'];
export const isDisplayField = (f: unknown): boolean => DISPLAY_FIELD_TYPES.includes((f as Loose | null)?.type as string);

/**
 * Resolve `{{path}}` against the builder's sample tree for the preview only.
 * Unresolvable paths are left standing, so a typo stays visible instead of
 * quietly turning into an empty string.
 */
export function fillTemplate(text: unknown, sampleRoot: unknown): string {
    const s = String(text ?? '');
    if (!s || !sampleRoot || !/\{\{[^}]+\}\}/.test(s)) return s;
    return s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full: string, expr: string) => {
        const v = walkPath(expr.trim(), sampleRoot);
        return v === undefined ? full : previewValue(v, 40);
    });
}

export interface BuildPreviewArgs {
    form: Loose | null | undefined;
    theme: Record<string, unknown> | null | undefined;
    isEnding?: boolean;
    allowVariables?: boolean;
    previewSample?: unknown;
    /** The translator, for the stand-in texts shown when there is no sample list. */
    t?: (key: string, fallback: string, vars?: Record<string, unknown>) => string;
}

// What the server caps the same things at (formFieldTypes.js): the preview shows the same number.
const MAX_OPTION_LEN = 120;
const MAX_OPTION_HINT_LEN = 200;
const DEFAULT_MAX_OPTIONS = 200;
const DEFAULT_MAX_FIELDS_FROM = 50;
const CHOICE_TYPES = ['select', 'radio', 'multiselect'];

const isScalar = (v: unknown): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const asText = (v: unknown, max: number): string => String(v).trim().slice(0, max).trim();

/** One list item as value / label / hint, or null when it has no usable value (as the server reads it). */
function readItem(item: unknown, spec: Loose): { value: string; label: string; hint?: string } | null {
    const raw = !spec.value && isScalar(item) ? item : getRelativePath(item, spec.value);
    if (!isScalar(raw)) return null;
    const value = asText(raw, MAX_OPTION_LEN);
    if (!value) return null;
    const out: { value: string; label: string; hint?: string } = { value, label: value };
    const l = spec.label ? getRelativePath(item, spec.label) : undefined;
    if (isScalar(l) || typeof l === 'boolean') out.label = asText(l, MAX_OPTION_LEN) || value;
    const h = spec.hint ? getRelativePath(item, spec.hint) : undefined;
    if ((isScalar(h) || typeof h === 'boolean') && asText(h, MAX_OPTION_HINT_LEN)) out.hint = asText(h, MAX_OPTION_HINT_LEN);
    return out;
}

/**
 * The distinct usable items of the list a source spec points at, or null when
 * there is no sample list to read (no spec, no sample, or the path is not a
 * list in it).
 */
function sampleItems(spec: Loose | null | undefined, sample: unknown, max: number) {
    const ref = typeof spec?.ref === 'string' ? spec.ref : '';
    const list = ref && sample ? (getList(sample, ref) as unknown[] | null) : null;
    if (!list || !spec) return null;
    const limit = Math.min(Number(spec.limit) > 0 ? Number(spec.limit) : Infinity, max);
    const seen = new Set<string>();
    const out: { value: string; label: string; hint?: string }[] = [];
    for (const item of list) {
        if (out.length >= limit) break;
        const o = readItem(item, spec);
        if (!o || seen.has(o.value)) continue;
        seen.add(o.value);
        out.push(o);
    }
    return out;
}

type Tr = NonNullable<BuildPreviewArgs['t']>;
const plain: Tr = (_key, fallback, vars) => (vars ? fallback.replace(/\{(\w+)\}/g, (m, k: string) => String(vars[k] ?? m)) : fallback);

/** Choices from an earlier step: the sample list's items, or two stand-ins when there is no sample. */
function previewOptionsFrom(spec: Loose, sample: unknown, t: Tr): FormOption[] {
    const items = sampleItems(spec, sample, DEFAULT_MAX_OPTIONS);
    if (items) return items;
    return [1, 2].map(n => ({ value: `option_${n}`, label: t('automations.form_wizard.preview_example_choice', 'Example choice {n}', { n }) }));
}

/** A question asked once per list item: the heading, then one question per sample item. */
function previewFieldsFrom(f: Loose, base: Loose, sample: unknown, t: Tr): Loose[] {
    const spec = f.fieldsFrom as Loose;
    const name = String(f.name);
    const items = sampleItems(spec, sample, DEFAULT_MAX_FIELDS_FROM)
        ?? [1, 2].map(n => ({ value: `item_${n}`, label: t('automations.form_wizard.preview_example_item', 'Example item {n}', { n }), hint: undefined as string | undefined }));
    const { label, help, ...attrs } = base;
    const header: Loose = {
        name: `${name}__0`, type: 'info', label, required: false, placeholder: '', help: '',
        content: help || '', group: name, groupHeader: true,
        ...(f.showIf ? { showIf: f.showIf } : {}),
    };
    return [header, ...items.map((it, i) => ({
        ...attrs, name: `${name}__${i + 1}`, label: it.label, help: it.hint || '', group: name, groupKey: it.value,
    }))];
}

/** One declared question as the renderer gets it (zero, one, or — per item — several). */
function previewField(f: Loose, ctx: { fill: (s: unknown) => string; allowVariables: boolean; sample: unknown; t: Tr }): Loose[] {
    const { fill, allowVariables, sample, t } = ctx;
    const { optionsFrom, fieldsFrom, ...rest } = f;
    const base: Loose = {
        ...rest,
        label: fill(f.label),
        placeholder: fill(f.placeholder),
        maxSizeMb: f.maxSizeMb || 10,
        options: normaliseOptions(f.options),
        // The real filename and size come from the ledger at serve time, so
        // the preview stands in for them.
        ...(FILE_FIELD_TYPES.includes(f.type as string) ? { filename: 'document.pdf', size: 182_000 } : {}),
        ...(f.type === 'info' ? { content: fill(f.content) } : {}),
        ...(typeof f.help === 'string' ? { help: fill(f.help) } : {}),
    };
    if (optionsFrom && CHOICE_TYPES.includes(f.type as string)) {
        // The first page is shown before anything ran: nothing to choose from there.
        const options = allowVariables ? previewOptionsFrom(optionsFrom as Loose, sample, t) : [];
        return [options.length ? { ...base, options } : { ...base, options: [], noOptions: true, required: false }];
    }
    if (allowVariables && fieldsFrom) return previewFieldsFrom({ ...f, fieldsFrom }, base, sample, t);
    return [base];
}

/**
 * What the form's preview renders: the declaration as the visitor's page
 * would be built from it. Mirrors the server's renderFormConfig: texts are
 * filled from the sample, choices and per-item questions from earlier steps
 * are resolved against the sample list (or shown as stand-ins when there is
 * none), and the source keys never reach the renderer. `showIf` and the answer
 * rules are kept, because the renderer applies them.
 */
export function buildPreviewConfig({ form, theme, isEnding = false, allowVariables = false, previewSample = null, t = plain }: BuildPreviewArgs) {
    const fill = allowVariables ? (s: unknown) => fillTemplate(s, previewSample) : (s: unknown) => (s as string);
    const fields = Array.isArray(form?.fields) ? (form.fields as Loose[]) : [];
    const ctx = { fill, allowVariables, sample: previewSample, t };
    return {
        title: fill(form?.title) || (isEnding ? 'All done' : 'Form'),
        description: fill(form?.description) || '',
        submitLabel: fill(form?.submitLabel) || 'Submit',
        successMessage: fill(form?.successMessage) || 'Thanks!',
        theme,
        fields: fields.filter(f => f?.name).flatMap(f => previewField(f, ctx)),
    };
}
