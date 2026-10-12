/**
 * settingsLayout: how the settings form lays its fields out, and how far a
 * group has been answered. The field table itself stays in settingsFields.js;
 * this file only reads it.
 *
 *   spanOf          the width a field takes in its group's grid: a third,
 *                   half or the full row. Short inputs share a row; lists,
 *                   toggles and the chip row take the whole row unless the
 *                   field table says otherwise (`span`).
 *   sectionsOf      the group's sub-headings (`sections` in the table) with
 *                   their fields in table order; a group without sections is
 *                   one untitled section.
 *   groupProgress   "{n} of {total} answered": every visible field that is a
 *                   question, so not a toggle (a checkbox has no unanswered
 *                   state), not the member picker that fills the DPO block,
 *                   not a field marked `optional`, and not a field hidden by
 *                   `dependsOn`.
 */

export type FieldSpan = 'third' | 'half' | 'full';

export interface SettingsFieldSpec {
    name: string;
    kind: string;
    section?: string;
    span?: FieldSpan;
    optional?: boolean;
    dependsOn?: string;
}

export interface SettingsSectionSpec {
    id: string;
    titleKey: string;
    titleEn: string;
}

export interface SettingsGroupSpec {
    id: string;
    fields: readonly SettingsFieldSpec[];
    sections?: readonly SettingsSectionSpec[];
}

export type SettingsForm = Record<string, unknown>;

const FULL_ROW_KINDS = new Set(['toggle', 'chips', 'emails', 'strings', 'contacts']);

export function spanOf(field: SettingsFieldSpec): FieldSpan {
    if (field.span === 'third' || field.span === 'half' || field.span === 'full') return field.span;
    return FULL_ROW_KINDS.has(field.kind) ? 'full' : 'half';
}

/**
 * The grid cell class per span, for the six-track grid of a group body that
 * is at least 640px wide (one column below it). Literals, so Tailwind emits them.
 */
export const SPAN_CLASS: Readonly<Record<FieldSpan, string>> = Object.freeze({
    third: 'min-w-0 @[640px]:col-span-2',
    half: 'min-w-0 @[640px]:col-span-3',
    full: 'min-w-0 @[640px]:col-span-6',
});

/** A field `dependsOn` another hides until that one is switched on. */
export function isVisible(field: SettingsFieldSpec, form: SettingsForm | null | undefined): boolean {
    return !field.dependsOn || form?.[field.dependsOn] === true;
}

export interface SettingsSection {
    id: string | null;
    titleKey: string | null;
    titleEn: string | null;
    fields: SettingsFieldSpec[];
}

export function sectionsOf(group: SettingsGroupSpec): SettingsSection[] {
    const declared = Array.isArray(group.sections) ? group.sections : [];
    if (declared.length === 0) return [{ id: null, titleKey: null, titleEn: null, fields: [...group.fields] }];
    const known = new Set(declared.map((s) => s.id));
    const out: SettingsSection[] = declared.map((s) => ({
        id: s.id, titleKey: s.titleKey, titleEn: s.titleEn,
        fields: group.fields.filter((f) => f.section === s.id),
    }));
    // A field whose section is missing from the table is never dropped from the form.
    const loose = group.fields.filter((f) => !f.section || !known.has(f.section));
    if (loose.length > 0) out.push({ id: null, titleKey: null, titleEn: null, fields: loose });
    return out;
}

const NOT_A_QUESTION = new Set(['toggle', 'userfill']);

/** True when the field holds an answer: text that is not blank, a list with an entry, a relevance that is not 'unknown'. */
export function isAnswered(field: SettingsFieldSpec, value: unknown, relevance = 'unknown'): boolean {
    if (field.kind === 'relevance') return relevance !== 'unknown' && relevance !== '';
    if (Array.isArray(value)) return value.length > 0;
    if (value === null || value === undefined) return false;
    return String(value).trim() !== '';
}

export interface GroupProgress { answered: number; total: number }

export function groupProgress(
    group: SettingsGroupSpec,
    form: SettingsForm | null | undefined,
    relevanceOf: (frameworkId: string) => string = () => 'unknown',
): GroupProgress {
    let answered = 0;
    let total = 0;
    for (const f of group.fields) {
        if (NOT_A_QUESTION.has(f.kind) || f.optional || !isVisible(f, form)) continue;
        total += 1;
        if (isAnswered(f, form?.[f.name], f.kind === 'relevance' ? relevanceOf(f.name) : undefined)) answered += 1;
    }
    return { answered, total };
}
