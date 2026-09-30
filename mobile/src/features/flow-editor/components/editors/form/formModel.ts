/**
 * One hosted form page — the declaration a form trigger (page one) and every
 * `form_page` step (page two on, and the closing page) carry — pure. From
 * agent-hub `Builder/flow/settings/FormBuilderFields.jsx`, a component file
 * the phone cannot load; form.lockstep.test.ts cuts the web's functions and
 * lists out of its text and compares.
 *
 * The author edits a question's LABEL; its `name` is minted once, when the
 * question is created, and never re-derived — re-deriving it would silently
 * break every `<base>.<name>` binding downstream.
 */

import type { FormDeclaration, FormField, FormTheme } from '@/features/flow-editor/model';

import { msg, type Msg } from '../declarative/spec';
import { moveAt, patchAt, removeAt } from '../shared/list';

export const FIELD_TYPES: readonly { value: string; label: Msg }[] = [
    { value: 'text', label: msg('mobile.flow.form.type_text', 'Short text') },
    { value: 'textarea', label: msg('mobile.flow.form.type_textarea', 'Long text') },
    { value: 'email', label: msg('mobile.flow.form.type_email', 'Email') },
    { value: 'number', label: msg('mobile.flow.form.type_number', 'Number') },
    { value: 'date', label: msg('mobile.flow.form.type_date', 'Date') },
    { value: 'select', label: msg('mobile.flow.form.type_select', 'Dropdown') },
    { value: 'checkbox', label: msg('mobile.flow.form.type_checkbox', 'Checkbox') },
    { value: 'file', label: msg('mobile.flow.form.type_file', 'File upload') },
    { value: 'app_pick', label: msg('mobile.flow.form.type_app_pick', 'Pick from an app') },
    { value: 'download', label: msg('mobile.flow.form.type_download', 'Download button') },
    { value: 'notebook', label: msg('mobile.flow.form.type_notebook', 'Open in Notebooks') },
];

/** Types that GIVE instead of ask: never submitted, never required, no placeholder or name to bind. */
export const DISPLAY_FIELD_TYPES: readonly string[] = ['download', 'notebook'];
export const isDisplayField = (f: { type?: unknown } | null | undefined): boolean => DISPLAY_FIELD_TYPES.includes(String(f?.type));

export const THEME_KNOBS: readonly { key: keyof FormTheme; label: Msg; values: readonly string[] }[] = [
    { key: 'radius', label: msg('mobile.flow.form.knob_radius', 'Corners'), values: ['none', 'sm', 'md', 'lg', 'xl'] },
    { key: 'density', label: msg('mobile.flow.form.knob_density', 'Spacing'), values: ['compact', 'comfortable', 'spacious'] },
    { key: 'fontScale', label: msg('mobile.flow.form.knob_font', 'Text size'), values: ['sm', 'md', 'lg'] },
    { key: 'appearance', label: msg('mobile.flow.form.knob_appearance', 'Appearance'), values: ['light', 'dark', 'auto'] },
];

export const COLOR_PRESETS: readonly string[] = [
    '#0F766E', '#0369A1', '#1D4ED8', '#0891B2', '#047857', '#4D7C0F',
    '#B45309', '#C2410C', '#B91C1C', '#BE185D', '#334155', '#57534E',
];

/** Label → field name, once: a valid identifier for the server's PARAM_NAME_RE, unique on the page. */
export function slugifyFieldName(label: unknown, taken: ReadonlySet<unknown> = new Set()): string {
    const base =
        String(label || '')
            .normalize('NFKD')
            .replace(/[^\w\s]/g, ' ')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^[^a-z]+/, '')
            .slice(0, 55) || 'field';
    if (!taken.has(base)) return base;
    for (let i = 2; i < 200; i += 1) {
        const candidate = `${base}_${i}`;
        if (!taken.has(candidate)) return candidate;
    }
    return `${base}_${Date.now().toString(36)}`;
}

/** Stored options (strings, or `{value,label}`) as `{value,label}` pairs; unreadable rows dropped. */
export function normaliseOptions(options: unknown): { value: string; label: string }[] {
    if (!Array.isArray(options)) return [];
    return options
        .map((o) => {
            if (typeof o === 'string') return { value: o, label: o };
            const row = o as { value?: unknown; label?: unknown } | null;
            if (row && typeof row === 'object' && row.value) return { value: String(row.value), label: String(row.label || row.value) };
            return null;
        })
        .filter((o): o is { value: string; label: string } => !!o);
}

/** A choice question's options as the list the author edits (blank values stay invisible). */
export function optionLines(options: unknown): string[] {
    return (Array.isArray(options) ? options : [])
        .map((o) => (typeof o === 'string' ? o : String((o as { value?: unknown } | null)?.value || '')))
        .filter(Boolean);
}

export const fieldsOf = (form: FormDeclaration | null | undefined): FormField[] => (Array.isArray(form?.fields) ? (form?.fields as FormField[]) : []);

const takenNames = (fields: readonly FormField[]) => new Set(fields.map((f) => f.name));

/** "Add a question": a short-text question named from its placeholder label. */
export function addQuestion(fields: readonly FormField[], label: string): FormField[] {
    return [...fields, { name: slugifyFieldName(label, takenNames(fields)), type: 'text', label, required: false, placeholder: '' }];
}

/** A closing page's download or "Open in Notebooks" — it points at a file, it asks nothing. */
export function addDisplayField(fields: readonly FormField[], type: 'download' | 'notebook', label: string): FormField[] {
    return [...fields, { name: slugifyFieldName(label, takenNames(fields)), type, label, fileId: '' }];
}

export const updateField = (fields: readonly FormField[], i: number, patch: Partial<FormField>): FormField[] => patchAt(fields, i, patch);
export const removeField = (fields: readonly FormField[], i: number): FormField[] => removeAt(fields, i);
export const moveField = (fields: readonly FormField[], i: number, dir: -1 | 1): FormField[] => moveAt(fields, i, dir);

/** Which preset the theme is exactly, if any. */
export function activePreset<P extends { id: string; theme: FormTheme }>(presets: readonly P[], theme: Partial<FormTheme> | null | undefined): P | null {
    return presets.find((p) => (Object.keys(p.theme) as (keyof FormTheme)[]).every((k) => p.theme[k] === theme?.[k])) ?? null;
}
