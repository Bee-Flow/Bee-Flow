/**
 * A framework's checks table (web: pages/FrameworkPage + framework/*). A
 * per-source check has one row per scope (an agent, a connection), so a row's
 * key on the phone is `<check_id>~<scope_id>`; an attention link that carries
 * only the check id opens its first row.
 */

import type { TranslateFn } from '@/core/i18n';

import type { CheckRow } from '../api/readers';

export function checkKey(check: Pick<CheckRow, 'check_id' | 'scope_id'>): string {
    return check.scope_id ? `${check.check_id}~${check.scope_id}` : check.check_id;
}

export function findCheck(checks: readonly CheckRow[] | undefined, key: string): CheckRow | undefined {
    return checks?.find((c) => checkKey(c) === key) ?? checks?.find((c) => c.check_id === key);
}

/** The row's title: a custom row's own title, else the check's translated title. */
export function checkTitle(check: CheckRow, t: TranslateFn): string {
    if (check.title) return check.title;
    return check.titleKey ? t(check.titleKey, check.check_id) : check.check_id;
}

export const isOpenCheck = (check: Pick<CheckRow, 'status'>): boolean => check.status === 'fail' || check.status === 'warn';

/** Fail before warn before the rest; then by severity, as the web sorts the table. */
const STATUS_RANK: Record<string, number> = { fail: 0, warn: 1, pending: 2, pass: 3, not_applicable: 4 };
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function sortChecks(checks: readonly CheckRow[]): CheckRow[] {
    return [...checks].sort(
        (a, b) =>
            (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
            (SEVERITY_RANK[a.severity ?? ''] ?? 9) - (SEVERITY_RANK[b.severity ?? ''] ?? 9) ||
            a.check_id.localeCompare(b.check_id),
    );
}

export function checkMeta(check: CheckRow, t: TranslateFn): string | undefined {
    const parts = [check.article ? t('compliance.mob_article', 'Art. {ref}', { ref: check.article }) : null];
    if (check.severity) parts.push(t(`compliance.sev_${check.severity}`, check.severity));
    if (check.scope_id) parts.push(check.scope_id);
    return parts.filter(Boolean).join(' · ') || undefined;
}
