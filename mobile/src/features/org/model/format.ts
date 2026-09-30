/**
 * Number and date wording for the org settings sections, as the web writes
 * it (OrgIntegrationCacheEditor.jsx, OrgAiContextEditor.jsx, OrgAcademyPanel.jsx).
 * Pure; `t` comes in as a parameter.
 *
 * Separators and dates follow the app's language (core/i18n), not 'en-US'
 * and not the phone's: a Dutch organisation read "750,000 tokens" — to a
 * Dutch reader, seven hundred and fifty.
 */

import { formatDate, formatNumber, type TranslateFn } from '@/core/i18n';

import type { AcademyMember } from './sectionTypes';

/** OrgIntegrationCacheEditor.jsx BYTES. */
export function formatBytes(n: number): string {
    if (n >= 1024 * 1024) return `${formatNumber(n / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
    if (n >= 1024) return `${formatNumber(Math.round(n / 1024))} kB`;
    return `${formatNumber(n)} B`;
}

export function minutesOf(seconds: number): number {
    return Math.round(seconds / 60);
}

/** OrgAiContextEditor.jsx: "750,000" (Dutch "750.000") reads better than "0.75M" here. */
export function formatTokens(n: number): string {
    return formatNumber(Math.round(n));
}

/** The web's `{{n}}` placeholders; the phone's own `t` interpolates `{n}` only. */
export function fill(text: string, values: Record<string, string | number>): string {
    let out = text;
    for (const [name, value] of Object.entries(values)) out = out.split(`{{${name}}}`).join(String(value));
    return out;
}

const DAY_MS = 86_400_000;

/** OrgAcademyPanel.jsx relativeTime, with its keys. */
export function relativeActivity(iso: string | null, t: TranslateFn, now = Date.now()): string {
    if (!iso) return t('org.academy.never', 'Not started');
    const days = Math.floor((now - new Date(iso).getTime()) / DAY_MS);
    if (days <= 0) return t('org.academy.today', 'Today');
    if (days === 1) return t('org.academy.yesterday', 'Yesterday');
    if (days < 30) return t('org.academy.days_ago', '{n} days ago', { n: days });
    const months = Math.floor(days / 30);
    if (months < 12) return t('org.academy.months_ago', '{n}mo ago', { n: months });
    return formatDate(iso);
}

/** The web's search: a member's name or email contains the (lower-cased) needle. */
export function memberMatches(member: AcademyMember, needle: string): boolean {
    return member.displayName.toLowerCase().includes(needle) || (member.email ?? '').toLowerCase().includes(needle);
}

/** The web's order: most recently active first; members who never started sink to the bottom. */
export function byActivity(members: readonly AcademyMember[]): AcademyMember[] {
    return [...members].sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
}
