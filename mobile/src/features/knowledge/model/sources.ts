/**
 * How a source reads and refreshes — ports of the web's
 * KnowledgeStudio/sourceKinds.js (label, glyph, subline) and ScheduleMenu.jsx
 * (refresh modes and the three schedule presets), pinned by
 * sources.lockstep.test.ts.
 *
 * The subline is a KEY per kind with a `_plural` twin, so "1 file" and
 * "3 files" are a translator's pair, not a letter glued on in code.
 */

import type { TranslateFn } from '@/core/i18n';
import { pluralKey } from '@/shared/lib/plural';
import type { IconName } from '@/shared/ui';

import type { KbSource, RefreshRule } from './types';

/** The kinds POST /:id/sources creates (sources.js CREATABLE_KINDS). */
export const CREATABLE_KINDS = Object.freeze(['text', 'upload', 'webpage', 'meeting_tag', 'datatable']);

interface KindInfo {
    icon: IconName;
    key: string;
    en: string;
}

const KINDS: Readonly<Record<string, KindInfo>> = {
    nextcloud_folder: { icon: 'Folder', key: 'knowledge.kind.nextcloud_folder', en: 'Folder in Nextcloud' },
    upload: { icon: 'Upload', key: 'knowledge.kind.upload', en: 'Upload files' },
    datatable: { icon: 'Table', key: 'knowledge.kind.datatable', en: 'Table' },
    meeting_tag: { icon: 'Mic', key: 'knowledge.kind.meeting_tag', en: 'Meeting notes' },
    webpage: { icon: 'Globe', key: 'knowledge.kind.webpage', en: 'Web page / URL' },
    text: { icon: 'FileText', key: 'knowledge.kind.text', en: 'Paste text' },
    automation: { icon: 'Workflow', key: 'knowledge.kind.automation', en: 'Let an automation fill it' },
    legacy: { icon: 'FileText', key: 'knowledge.kind.legacy', en: 'Imported' },
};

const kindOf = (kind: string): KindInfo => KINDS[kind] ?? (KINDS.legacy as KindInfo);

export function sourceIcon(kind: string): IconName {
    return kindOf(kind).icon;
}

export function sourceKindLabel(t: TranslateFn, kind: string): string {
    const info = kindOf(kind);
    return t(info.key, info.en);
}

const text = (v: unknown) => (typeof v === 'string' ? v : '');

interface Subline {
    key: string;
    one: string;
    many: string;
    params?: (source: SublineSource, t: TranslateFn) => Record<string, string | number>;
}

type SublineSource = Pick<KbSource, 'kind' | 'config' | 'documentCount' | 'createdByName'>;

const MEETING_FIELDS: Readonly<Record<string, [string, string]>> = {
    summary: ['knowledge.meeting.field_summary', 'Summary'],
    decisions: ['knowledge.meeting.field_decisions', 'Decisions'],
    actions: ['knowledge.meeting.field_actions', 'Actions'],
    questions: ['knowledge.meeting.field_questions', 'Open questions'],
};

function meetingFields(source: SublineSource, t: TranslateFn): string {
    const fields = Array.isArray(source.config.fields) && source.config.fields.length ? source.config.fields : ['summary', 'decisions'];
    return fields
        .map((f) => MEETING_FIELDS[String(f)])
        .filter((f): f is [string, string] => Boolean(f))
        .map(([key, en]) => t(key, en))
        .join(', ');
}

const SUBLINES: Readonly<Record<string, Subline>> = {
    nextcloud_folder: { key: 'knowledge.subline.folder', one: 'folder · {count} file', many: 'folder · {count} files' },
    upload: { key: 'knowledge.subline.upload', one: 'uploaded · {count} file', many: 'uploaded · {count} files' },
    datatable: {
        key: 'knowledge.subline.datatable',
        one: 'table {table} · {count} row',
        many: 'table {table} · {count} rows',
        params: (s) => ({ table: text(s.config.tableName) }),
    },
    meeting_tag: {
        key: 'knowledge.subline.meeting',
        one: '{fields} · {count} meeting',
        many: '{fields} · {count} meetings',
        params: (s, t) => ({ fields: meetingFields(s, t) }),
    },
    automation: {
        key: 'knowledge.subline.automation',
        one: 'filled by an automation · {count} document',
        many: 'filled by an automation · {count} documents',
    },
    legacy: { key: 'knowledge.subline.legacy', one: 'imported · {count} document', many: 'imported · {count} documents' },
};

const WEBPAGE: Subline = { key: 'knowledge.subline.webpage', one: 'web page · {count} page', many: 'web page · {count} pages' };
const WEBSITE: Subline = { key: 'knowledge.subline.webpage_site', one: 'whole site · {count} page', many: 'whole site · {count} pages' };

/** "uploaded · 3 files", "whole site · 12 pages", "pasted text · by Ann" — the web's sublineFor. */
export function sourceSubline(t: TranslateFn, source: SublineSource): string {
    if (source.kind === 'text') return t('knowledge.subline.text', 'pasted text · by {by}', { by: source.createdByName ?? '' });
    let n = Number(source.documentCount) || 0;
    let line = SUBLINES[source.kind] ?? (SUBLINES.legacy as Subline);
    if (source.kind === 'webpage') {
        n = n || 1;
        line = source.config.crawl ? WEBSITE : WEBPAGE;
    }
    return t(pluralKey(line.key, n), n === 1 ? line.one : line.many, { count: n, ...(line.params?.(source, t) ?? {}) });
}

/** The web's ScheduleMenu presets: 06:00 daily, Mondays, the 1st. */
export const CRON_PRESETS = Object.freeze([
    { id: 'daily', cron: '0 6 * * *', key: 'knowledge.schedule.daily', en: 'Every day at 06:00' },
    { id: 'weekly', cron: '0 6 * * 1', key: 'knowledge.schedule.weekly', en: 'Every Monday at 06:00' },
    { id: 'monthly', cron: '0 6 1 * *', key: 'knowledge.schedule.monthly', en: 'The 1st of each month at 06:00' },
] as const);

export function presetFor(cron: string | null | undefined) {
    const c = String(cron || '').trim();
    return CRON_PRESETS.find((p) => p.cron === c) ?? null;
}

const MODE_EN: Readonly<Record<string, string>> = {
    manual: 'Only when I ask',
    schedule: 'On a schedule',
    on_change: 'When it changes',
    after_meeting: 'After every meeting',
    live: 'Live — always current',
};

export function refreshModeLabel(t: TranslateFn, mode: string): string {
    return t(`knowledge.schedule.mode_${mode}`, MODE_EN[mode] ?? mode);
}

/** What the source's refresh currently is, in one line: the preset's words, or the mode's. */
export function refreshLabel(t: TranslateFn, source: Pick<KbSource, 'refreshMode' | 'refreshCron'>): string {
    if (source.refreshMode !== 'schedule') return refreshModeLabel(t, source.refreshMode);
    const preset = presetFor(source.refreshCron);
    return preset ? t(preset.key, preset.en) : t('knowledge.schedule.custom', 'Custom schedule ({cron})', { cron: source.refreshCron ?? '' });
}

/** The device's zone, which is what the web sends for "06:00" as well. */
export function deviceTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam';
    } catch {
        return 'Europe/Amsterdam';
    }
}

/** The rule a choice in the schedule sheet sends. Choosing "schedule" itself starts weekly, as on the web. */
export function ruleFor(mode: string, cron?: string): RefreshRule {
    if (mode !== 'schedule') return { mode };
    return { mode: 'schedule', cron: cron ?? CRON_PRESETS[1].cron, tz: deviceTimeZone() };
}
