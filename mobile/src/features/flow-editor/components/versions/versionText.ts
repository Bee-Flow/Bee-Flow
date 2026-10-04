/**
 * Plain-language text for the version history (handoff 5): a version's
 * one-line description (from the server's descriptionJson codes), its meta
 * line, and the grouping into Not live yet / Live / Earlier. Port of agent-hub
 * `Builder/versions/versionText.ts`, pinned by versions.lockstep.test.ts.
 */

import type { FlowVersionSummary, VersionDescriptionEntry } from '@/features/flow-editor/api';
import type { Translate } from '@/features/flow-editor/model';

type Params = Record<string, unknown>;
type Phrase = (t: Translate, p: Params) => string;

/** The server's params go into the sentence as they are; the translator only interpolates them. */
const as = (p: Params) => p as Record<string, string | number>;

/** Codes whose change leaves the automation's behaviour untouched. */
const NEUTRAL_CODES = new Set(['steps_reordered', 'layout_changed']);

const PHRASES: Record<string, Phrase> = {
    created: (t) => t('automations.versions.desc.created', 'Created'),
    created_from_template: (t, p) => t('automations.versions.desc.createdFromTemplate', 'Created from template "{template}"', as(p)),
    duplicated_from: (t, p) => t('automations.versions.desc.duplicatedFrom', 'Copied from "{title}"', as(p)),
    step_added: (t, p) => t('automations.versions.desc.stepAdded', 'Step added: "{step}"', as(p)),
    step_removed: (t, p) => t('automations.versions.desc.stepRemoved', 'Step removed: "{step}"', as(p)),
    step_changed: (t, p) => t('automations.versions.desc.stepChanged', 'Changed "{step}"', as(p)),
    setting_changed: (t, p) => t('automations.versions.desc.settingChanged', '{setting} changed in "{step}"', as({ ...p, setting: settingName(t, p.settingKey, p.setting) })),
    step_renamed: (t, p) => t('automations.versions.desc.stepRenamed', 'Step renamed to "{step}"', as(p)),
    steps_reordered: (t) => t('automations.versions.desc.stepsReordered', 'Steps reordered'),
    connections_changed: (t) => t('automations.versions.desc.connectionsChanged', 'Connections changed'),
    trigger_changed: (t) => t('automations.versions.desc.triggerChanged', 'Start changed'),
    settings_changed: (t, p) => (p.setting
        ? t('automations.versions.desc.automationSettingChanged', '{setting} changed', { setting: settingName(t, p.settingKey, p.setting) })
        : t('automations.versions.desc.settingsChanged', 'Settings changed')),
    description_changed: (t) => t('automations.versions.desc.descriptionChanged', 'Description changed'),
    restored: (t, p) => t('automations.versions.desc.restored', 'Restored from v{version}', as(p)),
};

/**
 * A setting's name: the server sends a code and its English label; the code
 * picks the translation (automations.versions.setting.<code>), the label is the
 * fallback.
 */
export function settingName(t: Translate, code: unknown, label: unknown): string {
    const english = typeof label === 'string' && label ? label : (typeof code === 'string' ? code : '');
    if (typeof code !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(code)) return english;
    return t(`automations.versions.setting.${code}`, english);
}

function phraseFor(entry: VersionDescriptionEntry, t: Translate): string | null {
    const fn = Object.hasOwn(PHRASES, entry.code) ? PHRASES[entry.code] : undefined;
    return fn ? fn(t, entry.params) : null;
}

/** The plain-language description of what this version changed. */
export function describeVersion(v: FlowVersionSummary, t: Translate): string {
    const phrases = v.descriptionJson.map((e) => phraseFor(e, t)).filter((s): s is string => !!s);
    if (phrases.length === 1) return phrases[0] as string;
    if (phrases.length > 1) {
        return t('automations.versions.desc.andMore', '{first} and {count} more', { first: phrases[0] as string, count: phrases.length - 1 });
    }
    return v.description ?? v.changeSummary ?? t('automations.versions.desc.fallback', 'Saved changes');
}

/** The row title: the milestone name when there is one, else the description. */
export function versionTitle(v: FlowVersionSummary, t: Translate): string {
    return v.name ?? describeVersion(v, t);
}

/** True when every described change is behaviour-neutral (a reorder). */
export function worksTheSame(v: FlowVersionSummary): boolean {
    return v.descriptionJson.length > 0 && v.descriptionJson.every((e) => NEUTRAL_CODES.has(e.code));
}

function sameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "22 Sep", or "Today 10:55" for today. */
export function shortWhen(iso: string | null, t: Translate, now: Date = new Date()): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    if (sameDay(d, now)) {
        const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        return t('automations.versions.todayAt', 'Today {time}', { time });
    }
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "22 Sep · admin · 36 runs, 1 failed" / "... · works the same". */
export function versionMeta(v: FlowVersionSummary, t: Translate, now: Date = new Date()): string {
    const parts: string[] = [];
    const when = shortWhen(v.savedAt, t, now);
    if (when) parts.push(when);
    if (v.savedByName) parts.push(v.savedByName);
    if (v.runs && v.runs.total > 0) {
        parts.push(v.runs.failed > 0
            ? t('automations.versions.runsFailed', '{count} runs, {failed} failed', { count: v.runs.total, failed: v.runs.failed })
            : t('automations.versions.runs', '{count} runs', { count: v.runs.total }));
    } else if (worksTheSame(v)) {
        parts.push(t('automations.versions.worksTheSame', 'works the same'));
    }
    return parts.join(' · ');
}

export interface VersionGroup {
    key: 'pending' | 'live' | 'earlier';
    rows: FlowVersionSummary[];
}

/**
 * Not live yet (newer than the live version, or everything when the automation
 * was never live), Live, Earlier. Rows arrive newest first.
 */
export function groupVersions(rows: readonly FlowVersionSummary[]): VersionGroup[] {
    const live = rows.find((r) => r.isLive) ?? null;
    const pending = live ? rows.filter((r) => r.version > live.version) : [...rows];
    const earlier = live ? rows.filter((r) => r.version < live.version) : [];
    const groups: VersionGroup[] = [];
    if (pending.length) groups.push({ key: 'pending', rows: pending });
    if (live) groups.push({ key: 'live', rows: [live] });
    if (earlier.length) groups.push({ key: 'earlier', rows: earlier });
    return groups;
}

/** A group's heading. */
export function groupLabel(key: VersionGroup['key'], t: Translate): string {
    if (key === 'pending') return t('automations.versions.group.pending', 'Not live yet');
    if (key === 'live') return t('automations.versions.group.live', 'Live');
    return t('automations.versions.group.earlier', 'Earlier');
}
