/**
 * The numbers on the hub's rows (web: railMeta.js + useComplianceCounts.js).
 *
 * One rule, the web's: a number the server did not state renders NOTHING. A
 * missing key is `null` here and every meta below answers null for it, so a
 * row shows its label and no invented "0".
 */

import type { TranslateFn } from '@/core/i18n';

import { frameworkIdOf, type ComplianceSection } from './sections';
import type { RecordTone } from './types';

export interface ComplianceCounts {
    attentionOpen: number | null;
    lastRunAt: string | null;
    /** framework id → score, for the ENABLED frameworks only. */
    scores: Readonly<Record<string, number | null>>;
    candidates: number | null;
    recentlyInForce: number | null;
    dsr: { open: number; overdue: number | null } | null;
    incidents: { open: number; hoursLeft: number | null; vulnerabilitiesOpen: number | null } | null;
    ropaReviewedAt: string | null;
    dpiaTodo: number | null;
    risks: { total: number; high: number | null } | null;
    soa: { approved: number; total: number } | null;
    policies: { total: number; reviewDue: number | null } | null;
    auditsPlanned: number | null;
    training: { done: number; total: number } | null;
    connectors: { count: number; nextSweepAt: string | null } | null;
    onboarded: boolean | null;
}

export interface RowMeta {
    text: string;
    tone?: RecordTone;
}

/** 'HH:MM', 24 h, as the web's rail writes it; null for no or a bad date. */
export function formatClock(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** '12 Sep' style day; null for no or a bad date. */
export function formatDay(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** A 0–100 score's tone: ≥ 85 good, ≥ 60 attention, else gaps; none is neutral. */
export function toneOfScore(score: number | null | undefined): RecordTone {
    if (score === null || score === undefined || !Number.isFinite(score)) return 'neutral';
    if (score >= 85) return 'success';
    if (score >= 60) return 'warning';
    return 'error';
}

/** The overview headline under a framework's score (web: statusTone.headlineKeyOfScore). */
export function headlineOfScore(score: number | null | undefined, t: TranslateFn): string {
    switch (toneOfScore(score)) {
        case 'success':
            return t('compliance.ovw_headline_good', 'You are in good shape');
        case 'warning':
            return t('compliance.ovw_headline_attention', 'A few items need attention');
        case 'error':
            return t('compliance.ovw_headline_gaps', 'Clear gaps');
        default:
            return t('compliance.ovw_headline_pending', 'Score after the first run');
    }
}

/** 'run today 09:12 · 7 open' — each half only when the counts stated it. */
export function hubSubtitle(counts: ComplianceCounts | null | undefined, t: TranslateFn): string | null {
    if (!counts) return null;
    const parts: string[] = [];
    const time = formatClock(counts.lastRunAt);
    if (time) parts.push(t('compliance.mob_run_today', 'run today {time}', { time }));
    if (counts.attentionOpen !== null) parts.push(t('compliance.rail_meta_open', '{n} open', { n: counts.attentionOpen }));
    return parts.length ? parts.join(' · ') : null;
}

export function scoreOf(counts: ComplianceCounts | null | undefined, section: ComplianceSection): number | null {
    return counts?.scores[frameworkIdOf(section)] ?? null;
}

function open(n: number, t: TranslateFn): string {
    return t('compliance.rail_meta_open', '{n} open', { n });
}

function frameworksMeta(c: ComplianceCounts, t: TranslateFn): RowMeta | null {
    if (c.candidates === null) return null;
    const text =
        c.recentlyInForce && c.recentlyInForce > 0
            ? t('compliance.rail_meta_candidates_recent', '{n} candidates · {m} just in force', { n: c.candidates, m: c.recentlyInForce })
            : t('compliance.rail_meta_candidates', '{n} candidates', { n: c.candidates });
    return { text };
}

function dsrMeta(c: ComplianceCounts, t: TranslateFn): RowMeta | null {
    if (!c.dsr) return null;
    const overdue = c.dsr.overdue ?? 0;
    return overdue > 0 ? { text: `${overdue} · ${open(c.dsr.open, t)}`, tone: 'error' } : { text: open(c.dsr.open, t) };
}

function incidentsMeta(c: ComplianceCounts, t: TranslateFn): RowMeta | null {
    if (!c.incidents) return null;
    const hours = c.incidents.hoursLeft;
    if (hours === null) return { text: open(c.incidents.open, t) };
    const badge = t('compliance.clock_short_hours', '{hours} h', { hours: Math.max(0, Math.ceil(hours)) });
    const tone: RecordTone = hours <= 0 ? 'error' : hours <= 24 ? 'warning' : 'success';
    return { text: `${badge} · ${open(c.incidents.open, t)}`, tone };
}

function connectorsMeta(c: ComplianceCounts, t: TranslateFn): RowMeta | null {
    if (!c.connectors) return null;
    const time = formatClock(c.connectors.nextSweepAt);
    return { text: time ? t('compliance.rail_meta_connectors', '{n} · sweep {time}', { n: c.connectors.count, time }) : String(c.connectors.count) };
}

function isoMeta(section: string, c: ComplianceCounts, t: TranslateFn): RowMeta | null {
    switch (section) {
        case 'risks':
            if (!c.risks) return null;
            return { text: c.risks.high === null ? String(c.risks.total) : t('compliance.rail_meta_risks', '{n} · {high} high', { n: c.risks.total, high: c.risks.high }) };
        case 'soa':
            return c.soa ? { text: t('compliance.rail_meta_soa', '{approved}/{total} approved', { approved: c.soa.approved, total: c.soa.total }) } : null;
        case 'policies':
            if (!c.policies) return null;
            return { text: c.policies.reviewDue ? t('compliance.rail_meta_policies_due', '{n} · {due} review', { n: c.policies.total, due: c.policies.reviewDue }) : String(c.policies.total) };
        case 'audits':
            return c.auditsPlanned === null ? null : { text: t('compliance.rail_meta_planned', '{n} planned', { n: c.auditsPlanned }) };
        case 'training':
            return c.training ? { text: `${c.training.done}/${c.training.total}` } : null;
        case 'connectors':
            return connectorsMeta(c, t);
        default:
            return null;
    }
}

function registerMeta(section: string, c: ComplianceCounts, t: TranslateFn): RowMeta | null {
    switch (section) {
        case 'dsr':
            return dsrMeta(c, t);
        case 'incidents':
            return incidentsMeta(c, t);
        case 'vulnerabilities':
            return c.incidents?.vulnerabilitiesOpen == null ? null : { text: open(c.incidents.vulnerabilitiesOpen, t) };
        case 'ropa': {
            const day = formatDay(c.ropaReviewedAt);
            return day ? { text: t('compliance.rail_meta_reviewed', 'reviewed {date}', { date: day }) } : null;
        }
        case 'dpia':
            return c.dpiaTodo === null ? null : { text: t('compliance.rail_meta_todo', '{n} to do', { n: c.dpiaTodo }) };
        case 'settings':
            return { text: t('compliance.rail_meta_settings', 'DPO · legal bases') };
        default:
            return isoMeta(section, c, t);
    }
}

/** The right-hand text of a hub row; null when the counts said nothing about it. */
export function rowMeta(section: ComplianceSection, counts: ComplianceCounts | null | undefined, t: TranslateFn): RowMeta | null {
    if (!counts) return section.id === 'settings' ? registerMeta('settings', emptyCounts(), t) : null;
    if (section.view === 'checks' || section.id === 'machinery' || section.id === 'custom') {
        const score = scoreOf(counts, section);
        return score === null ? null : { text: String(score), tone: toneOfScore(score) };
    }
    if (section.id === 'frameworks') return frameworksMeta(counts, t);
    return registerMeta(section.id, counts, t);
}

export function emptyCounts(): ComplianceCounts {
    return {
        attentionOpen: null,
        lastRunAt: null,
        scores: {},
        candidates: null,
        recentlyInForce: null,
        dsr: null,
        incidents: null,
        ropaReviewedAt: null,
        dpiaTodo: null,
        risks: null,
        soa: null,
        policies: null,
        auditsPlanned: null,
        training: null,
        connectors: null,
        onboarded: null,
    };
}
