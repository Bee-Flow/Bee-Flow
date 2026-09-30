/**
 * The Formatter the registry titles and summaries read: translation, a
 * locale date, and a member's name for an owner id (from GET /org-users,
 * fetched only by screens that show owners).
 */

import { useTranslation } from '@/core/i18n';

import { useOrgUsers } from './queries';
import type { Formatter } from '../model/types';

export function formatDate(value: unknown): string | null {
    if (typeof value !== 'string' || !value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function useFormatter(withUsers: boolean): Formatter {
    const t = useTranslation();
    const users = useOrgUsers(withUsers);
    const names = new Map((users.data ?? []).map((u) => [u.id, u.displayName]));
    return {
        t,
        date: formatDate,
        user: (id) => (typeof id === 'string' && id ? names.get(id) ?? id : null),
    };
}
