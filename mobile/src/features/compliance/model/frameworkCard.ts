/**
 * The decisions one framework row makes, ported from the web's
 * pages/frameworks/FrameworkCandidateCard.jsx (statusChipOf, enableIsPrimary,
 * recommendedReason, countLabel) and pages/FrameworksPage.jsx
 * (candidateList, frameworkGroups); pinned by frameworkCard.test.ts.
 */

import type { TranslateFn } from '@/core/i18n';

import { daysUntil, parseDay, SOON_DAYS } from './calendarMath';

export interface FrameworkLike {
    id: string;
    core?: boolean;
    enabled?: boolean;
    locked?: string | null;
    relevance?: string | null;
    relevance_gate?: boolean;
    recently_in_force?: boolean;
    in_force_since?: string | null;
    in_force_from?: string | null;
    affects?: Record<string, number> | null;
    checks_count?: number | null;
    registers?: readonly string[] | null;
    calendar_count?: number | null;
}

export interface StatusChip {
    tone: 'success' | 'warning' | 'neutral';
    key: string;
    fallback: string;
    date: string;
    days: number | null;
}

/** Which status chip a framework wears today; null when it has no date at all. */
export function statusChipOf(framework: FrameworkLike | null | undefined, now: number = Date.now()): StatusChip | null {
    if (!framework) return null;
    if (framework.in_force_since) {
        return { tone: 'success', key: 'compliance.fw_in_force_since', fallback: 'in force since {date}', date: framework.in_force_since, days: null };
    }
    if (framework.in_force_from) {
        const days = daysUntil(parseDay(framework.in_force_from), now);
        if (typeof days === 'number' && days >= 0 && days <= SOON_DAYS) {
            return { tone: 'warning', key: 'compliance.fw_from_in_days', fallback: 'from {date} · in {days} days', date: framework.in_force_from, days };
        }
        return { tone: 'neutral', key: 'compliance.fw_from', fallback: 'from {date}', date: framework.in_force_from, days };
    }
    return null;
}

/** Does Enable wear the primary recipe? (recently in force, or marked relevant) */
export function enableIsPrimary(framework: FrameworkLike | null | undefined): boolean {
    return !!framework && (framework.recently_in_force === true || framework.relevance === 'relevant');
}

/** Why a framework is recommended; null when it is not. */
export function recommendedReason(framework: FrameworkLike | null | undefined, t: TranslateFn): string | null {
    if (!framework || !enableIsPrimary(framework)) return null;
    return framework.recently_in_force === true
        ? t('compliance.fw_recommended_recent', 'Recently entered into force')
        : t('compliance.fw_recommended_relevant', 'You marked this framework as relevant');
}

/** A count in words: `<key>_one` for 1, else `<key>` (the web's countLabel(t, key, n, fallback, one)). */
export function countLabel(t: TranslateFn, key: string, n: number, words: { many: string; one?: string }): string {
    return n === 1 ? t(`${key}_one`, words.one ?? words.many.replace('{n}', '1'), { n }) : t(key, words.many, { n });
}

/** Every non-core framework; null while unread. */
export function candidateList<T extends FrameworkLike>(frameworks: readonly T[] | null | undefined): T[] | null {
    if (!Array.isArray(frameworks)) return null;
    return frameworks.filter((f) => f && !f.core);
}

/** The non-core frameworks in the page's two groups; null while unread. */
export function frameworkGroups<T extends FrameworkLike>(frameworks: readonly T[] | null | undefined): { enabled: T[]; available: T[] } | null {
    const list = candidateList(frameworks);
    if (!list) return null;
    return { enabled: list.filter((f) => f.enabled === true), available: list.filter((f) => f.enabled !== true) };
}

/** Locked for one of the two reasons the card shows a lock for. */
export const isLocked = (f: FrameworkLike): boolean => f.locked === 'ceiling' || f.locked === 'not_granted';

/** A candidate whose relevance the org may decline in place (DORA, Machinery, a relevance gate). */
export const isGated = (f: FrameworkLike): boolean => f.relevance_gate === true || f.id === 'dora' || f.id === 'machinery';

const AFFECTS_NOUN: Readonly<Record<string, readonly [string, string]>> = {
    automations: ['automations', 'automation'],
    agents: ['agents', 'agent'],
    webpages: ['web pages', 'web page'],
    forms: ['public forms', 'public form'],
    detections: ['machine integrations', 'machine integration'],
};

/** "3 automations · 1 agent": the positive affects counts, '' when none. */
export function affectsCounts(affects: Record<string, number> | null | undefined, t: TranslateFn): string {
    return Object.entries(affects ?? {})
        .filter(([, v]) => v > 0)
        .map(([k, v]) => {
            const [many, one] = AFFECTS_NOUN[k] ?? [k, k];
            return `${v} ${v === 1 ? t(`compliance.fw_affects_${k}_one`, one) : t(`compliance.fw_affects_${k}`, many)}`;
        })
        .join(' · ');
}

/** "{n} checks · {n} registers · {n} calendar dates", empty parts dropped. */
export function frameworkMeta(f: FrameworkLike, t: TranslateFn): string {
    const registers = Array.isArray(f.registers) ? f.registers.length : null;
    return [
        typeof f.checks_count === 'number' ? countLabel(t, 'compliance.fw_meta_checks', f.checks_count, { many: '{n} checks', one: '1 check' }) : null,
        registers ? countLabel(t, 'compliance.fw_meta_registers', registers, { many: '{n} registers', one: '1 register' }) : null,
        f.calendar_count ? countLabel(t, 'compliance.fw_meta_dates', f.calendar_count, { many: '{n} calendar dates', one: '1 calendar date' }) : null,
    ]
        .filter(Boolean)
        .join(' · ');
}

/** The toast after a failed switch: the plan sentence on a 403, else the generic one. */
export function toggleFailureText(status: number | undefined, t: TranslateFn): string {
    return status === 403
        ? t('compliance.fw_toast_locked', 'This framework is not included in your plan')
        : t('compliance.fw_toast_failed', 'Could not update the framework');
}

/** The legal register's review line (web ComplianceHeader legalStatusChip): info, or warning when due or unknown. */
export function legalStatusOf(catalogue: { verified_on: string | null; stale: boolean } | null | undefined, t: TranslateFn, fmt: (date: string) => string = (d) => d): { tone: 'info' | 'warning'; text: string } {
    if (!catalogue?.verified_on) return { tone: 'warning', text: t('compliance.hdr_fw_review_unknown', 'Legal status not recorded · due for review') };
    const date = fmt(catalogue.verified_on);
    return catalogue.stale
        ? { tone: 'warning', text: t('compliance.hdr_fw_review_due', 'Legal status checked {date} · due for review', { date }) }
        : { tone: 'info', text: t('compliance.hdr_fw_checked', 'Legal status checked {date} · not legal advice', { date }) };
}

/** "{active} active · {candidates} candidates · {n} just in force"; null until both counts are known. */
export function frameworkSummary(c: { active: number | null; candidates: number | null; recent: number | null }, t: TranslateFn): string | null {
    if (c.active === null || c.candidates === null) return null;
    const base = t('compliance.hdr_fw_summary', '{active} active · {candidates} candidates', { active: c.active, candidates: c.candidates });
    return c.recent && c.recent > 0 ? `${base} · ${t('compliance.hdr_fw_recent', '{n} just in force', { n: c.recent })}` : base;
}
