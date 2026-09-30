/**
 * What a draft card shows, read out of the server's draft record. The
 * record is untyped on purpose (it is posted back through an allow-list,
 * draftPayloads.ts); this is the typed view of it the cards draw.
 */

import type { TranslateFn } from '@/core/i18n';

import type { DraftRecord } from './types';

export function text(draft: DraftRecord, key: string): string {
    const value = draft[key];
    return typeof value === 'string' ? value : '';
}

/** "Mon 3 Mar 2026, 14:00" in the phone's locale; the raw string when it is not a date. */
export function formatDateTime(iso: string): string {
    if (!iso) return '';
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) return iso;
    return when.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The event's length in words, or null without both ends (the web's formatDuration). */
export function eventDuration(start: string, end: string, t: TranslateFn): string | null {
    if (!start || !end) return null;
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (!Number.isFinite(ms)) return null;
    const mins = Math.round(ms / 60000);
    if (mins < 60) return t('chat.draft.cal_dur_min', '{count} min', { count: mins });
    const hours = Math.floor(mins / 60);
    const minutes = mins % 60;
    return minutes > 0
        ? t('chat.draft.cal_dur_h_m', '{hours}h {minutes}m', { hours, minutes })
        : t('chat.draft.cal_dur_h', '{hours}h', { hours });
}

/** "a@x.nl, b@y.nl" as a list. */
export function attendeesOf(draft: DraftRecord): string[] {
    return text(draft, 'attendees')
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);
}

/** A contact's name, first and last, or the generic word. */
export function contactName(draft: DraftRecord, t: TranslateFn): string {
    const name = `${text(draft, 'firstName')}${text(draft, 'lastName') ? ` ${text(draft, 'lastName')}` : ''}`.trim();
    return name || t('chat.draft.contact_fallback', 'Contact');
}

/** A Keep checklist, read defensively: an item is words and whether it is ticked. */
export function checklistOf(draft: DraftRecord): { text: string; checked: boolean }[] {
    const items = draft.listItems;
    if (!Array.isArray(items)) return [];
    return items.map((item) => {
        const i = (item ?? {}) as { text?: unknown; checked?: unknown };
        return { text: typeof i.text === 'string' ? i.text : '', checked: i.checked === true };
    });
}
