/**
 * The Formatter the registry titles and summaries read: translation, a
 * locale date, a day-and-time and a log stamp in the app's language
 * (model/time.ts), the wall clock (re-read each minute), and a member's name
 * for an owner id — '—' for one who is not a member, never the raw id. The
 * member directory is read only by screens that show owners.
 */

import { useTranslation } from '@/core/i18n';

import { useMembers } from './members';
import { useNow } from './useNow';
import { formatDayTime, formatStamp } from '../model/time';
import type { Formatter } from '../model/types';

export function formatDate(value: unknown): string | null {
    if (typeof value !== 'string' || !value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const asTime = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? value : null);

export function useFormatter(withUsers: boolean): Formatter {
    const t = useTranslation();
    const now = useNow();
    const members = useMembers(withUsers);
    const names = new Map((members.data ?? []).map((u) => [u.id, u.displayName || u.email || '—']));
    return {
        t,
        now,
        date: formatDate,
        dayTime: (v) => formatDayTime(asTime(v), undefined, now) || null,
        stamp: (v) => formatStamp(asTime(v), undefined, now) || null,
        user: (id) => (typeof id === 'string' && id ? names.get(id) ?? '—' : null),
    };
}
