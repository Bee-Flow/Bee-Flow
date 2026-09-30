/**
 * The settings form's state and body (web: settingsFields.normaliseSettings /
 * buildSettingsBody), with one difference: the web PUTs every column back, the
 * phone PUTs only the columns that changed — the server merges, and a phone
 * that cannot edit a column (the DORA contacts) must not write it back.
 */

import { SETTING_GROUPS, type SettingField } from './settingsFields';

export type SettingValue = string | boolean | string[] | null;
export type SettingsForm = Record<string, SettingValue>;

const EDITABLE = SETTING_GROUPS.flatMap((g) => g.fields).filter((f) => f.kind !== 'relevance' && f.kind !== 'contacts');

const asText = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function formValue(field: SettingField, v: unknown): SettingValue {
    switch (field.kind) {
        case 'toggle':
            // A switch that is on until someone turns it off: no value yet is on.
            return field.defaultOn && (v === null || v === undefined) ? true : v === true;
        case 'chips':
        case 'emails':
        case 'strings':
            return asList(v);
        case 'date':
            return typeof v === 'string' ? v.slice(0, 10) : '';
        case 'stamp':
            return typeof v === 'string' && v ? v : null;
        default:
            return asText(v);
    }
}

/** Server settings → form state; an absent value is the empty answer, never a guess (a toggle marked defaultOn reads as on, as on the web). */
export function normaliseSettings(settings: Readonly<Record<string, unknown>> | null | undefined): SettingsForm {
    const s = settings ?? {};
    const form: SettingsForm = {};
    for (const field of EDITABLE) form[field.name] = formValue(field, s[field.name]);
    return form;
}

function bodyValue(field: SettingField, v: SettingValue): unknown {
    switch (field.kind) {
        case 'toggle':
            return v === true;
        case 'chips':
        case 'emails':
        case 'strings':
            return (Array.isArray(v) ? v : []).map((x) => x.trim()).filter(Boolean);
        case 'number': {
            const n = asText(v).trim();
            return n === '' ? null : Number(n);
        }
        case 'stamp':
            return v || null;
        default: {
            const text = asText(v).trim();
            return text === '' ? null : text;
        }
    }
}

const same = (a: SettingValue, b: SettingValue): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The PUT body: every changed column, typed as the server's column is. */
export function settingsPatch(base: SettingsForm, form: SettingsForm): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    for (const field of EDITABLE) {
        const v = form[field.name] ?? null;
        if (same(v, base[field.name] ?? null)) continue;
        body[field.name] = bodyValue(field, v);
    }
    return body;
}

/** The DORA contacts count the phone shows (it does not edit the list). */
export function contactCount(settings: Readonly<Record<string, unknown>> | null | undefined, name: string): number {
    const v = settings?.[name];
    return Array.isArray(v) ? v.filter((c) => c !== null && typeof c === 'object').length : 0;
}

/** Numbers and dates the form will not send as typed. */
export function settingsErrors(form: SettingsForm): string[] {
    return EDITABLE.filter((f) => {
        const text = asText(form[f.name]).trim();
        if (!text) return false;
        if (f.kind === 'number') return !Number.isFinite(Number(text));
        if (f.kind === 'date') return !/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text));
        return false;
    }).map((f) => f.name);
}
