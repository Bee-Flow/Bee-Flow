// Plain-language text for the Versions tab: a version's one-line description
// (from the server's descriptionJson codes), its meta line, and the grouping
// into Not live yet / Live / Earlier.

import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { DescriptionEntry, VersionRow } from '../../../../api/queries/automation/versions';

type Phrase = (t: TranslateFn, p: Record<string, unknown>) => string;

/** Codes whose change leaves the routine's behaviour untouched. */
const NEUTRAL_CODES = new Set(['steps_reordered', 'layout_changed']);

const PHRASES: Record<string, Phrase> = {
    created: (t) => t('routines.versions.desc.created', 'Created'),
    created_from_template: (t, p) => t('routines.versions.desc.createdFromTemplate', 'Created from template "{template}"', p),
    duplicated_from: (t, p) => t('routines.versions.desc.duplicatedFrom', 'Copied from "{title}"', p),
    step_added: (t, p) => t('routines.versions.desc.stepAdded', 'Step added: "{step}"', p),
    step_removed: (t, p) => t('routines.versions.desc.stepRemoved', 'Step removed: "{step}"', p),
    step_changed: (t, p) => t('routines.versions.desc.stepChanged', 'Changed "{step}"', p),
    setting_changed: (t, p) => t('routines.versions.desc.settingChanged', '{setting} changed in "{step}"', { ...p, setting: settingName(t, p.settingKey, p.setting) }),
    step_renamed: (t, p) => t('routines.versions.desc.stepRenamed', 'Step renamed to "{step}"', p),
    steps_reordered: (t) => t('routines.versions.desc.stepsReordered', 'Steps reordered'),
    connections_changed: (t) => t('routines.versions.desc.connectionsChanged', 'Connections changed'),
    trigger_changed: (t) => t('routines.versions.desc.triggerChanged', 'Start changed'),
    settings_changed: (t, p) => (p.setting
        ? t('routines.versions.desc.routineSettingChanged', '{setting} changed', { setting: settingName(t, p.settingKey, p.setting) })
        : t('routines.versions.desc.settingsChanged', 'Settings changed')),
    description_changed: (t) => t('routines.versions.desc.descriptionChanged', 'Description changed'),
    restored: (t, p) => t('routines.versions.desc.restored', 'Restored from v{version}', p),
    // "Koppelingen bijwerken" (UpgradeMappingsDialog): one version for the lot.
    mappings_upgraded: (t, p) => t('mapping.upgrade.version_desc', 'Mappings updated ({count} field(s))', p),
};

/**
 * A setting's name: the server sends a code and its English label; the code
 * picks the translation (routines.versions.setting.<code>), the label is the
 * fallback.
 */
export function settingName(t: TranslateFn, code: unknown, label: unknown): string {
    const english = typeof label === 'string' && label ? label : (typeof code === 'string' ? code : '');
    if (typeof code !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(code)) return english;
    return t(`routines.versions.setting.${code}`, english);
}

function phraseFor(entry: DescriptionEntry, t: TranslateFn): string | null {
    const fn = PHRASES[entry.code];
    return fn ? fn(t, entry.params) : null;
}

/** The plain-language description of what this version changed. */
export function describeVersion(v: VersionRow, t: TranslateFn): string {
    const phrases = v.descriptionJson.map((e) => phraseFor(e, t)).filter((s): s is string => !!s);
    if (phrases.length === 1) return phrases[0];
    if (phrases.length > 1) {
        return t('routines.versions.desc.andMore', '{first} and {count} more', { first: phrases[0], count: phrases.length - 1 });
    }
    return v.description ?? v.changeSummary ?? t('routines.versions.desc.fallback', 'Saved changes');
}

/** The row title: the milestone name when there is one, else the description. */
export function versionTitle(v: VersionRow, t: TranslateFn): string {
    return v.name ?? describeVersion(v, t);
}

/** True when every described change is behaviour-neutral (a reorder). */
export function worksTheSame(v: VersionRow): boolean {
    return v.descriptionJson.length > 0 && v.descriptionJson.every((e) => NEUTRAL_CODES.has(e.code));
}

function sameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "22 Sep", or "Today 10:55" for today. */
export function shortWhen(iso: string | null, t: TranslateFn, now: Date = new Date()): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    if (sameDay(d, now)) {
        const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        return t('routines.versions.todayAt', 'Today {time}', { time });
    }
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "22 Sep · admin · 36 runs, 1 failed" / "... · works the same". */
export function versionMeta(v: VersionRow, t: TranslateFn, now: Date = new Date()): string {
    const parts: string[] = [];
    const when = shortWhen(v.savedAt, t, now);
    if (when) parts.push(when);
    if (v.savedByName) parts.push(v.savedByName);
    if (v.runs && v.runs.total > 0) {
        parts.push(v.runs.failed > 0
            ? t('routines.versions.runsFailed', '{count} runs, {failed} failed', { count: v.runs.total, failed: v.runs.failed })
            : t('routines.versions.runs', '{count} runs', { count: v.runs.total }));
    } else if (worksTheSame(v)) {
        parts.push(t('routines.versions.worksTheSame', 'works the same'));
    }
    return parts.join(' · ');
}

export interface VersionGroup {
    key: 'pending' | 'live' | 'earlier';
    rows: VersionRow[];
}

/**
 * Not live yet (newer than the live version, or everything when the routine
 * was never live), Live, Earlier. Rows arrive newest first.
 */
export function groupVersions(rows: VersionRow[]): VersionGroup[] {
    const live = rows.find((r) => r.isLive) ?? null;
    const pending = live ? rows.filter((r) => r.version > live.version) : rows;
    const earlier = live ? rows.filter((r) => r.version < live.version) : [];
    const groups: VersionGroup[] = [];
    if (pending.length) groups.push({ key: 'pending', rows: pending });
    if (live) groups.push({ key: 'live', rows: [live] });
    if (earlier.length) groups.push({ key: 'earlier', rows: earlier });
    return groups;
}

/** Milestones only: named versions, plus the live and the editing row as anchors. */
export function milestonesOnly(rows: VersionRow[]): VersionRow[] {
    return rows.filter((r) => r.name || r.isLive || r.isEditing);
}

/** Render any stored setting value as short readable text. */
export function formatValue(value: unknown): string {
    if (value == null || value === '') return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const json = JSON.stringify(value);
    return json.length > 140 ? `${json.slice(0, 139)}…` : json;
}
