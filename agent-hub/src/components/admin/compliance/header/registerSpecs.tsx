/**
 * registerSpecs: the header spec of every register section (requests,
 * incidents, ROPA, risks, SoA, ...) and of the two framework sections that
 * are not a checks table (own frameworks, machinery). ComplianceHeader merges
 * them into HEADER_SPECS; it keeps the overview, the frameworks list and the
 * framework default itself.
 *
 * A spec answers `(ctx, t, base) → { pill, infoChip, secondary, primary,
 * tabCounts }`. `base` is the framework default for a section that scores a
 * regulation (custom, machinery), so those override only what differs.
 *
 * Actions come from the page through the hub's setHeaderActions. The keys a
 * page may set, besides the data objects the hub passes itself:
 *   onCaptureRequest, onRecordIncident, onRecordVulnerability, onAddRisk,
 *   onSeedRisks             the register's create actions
 *   onMarkRopaReviewed, onRegenerateRopa, ropaBusy   ROPA (RopaPage)
 *   portabilityCoverage, onRefreshPortability        Data portability
 *   onAddFramework, onRefreshMachinery               own frameworks, machinery
 *   primaryAction           { label, icon, onClick, disabled? }: a generic
 *                           primary that audits, policies and training may set
 * A missing handler renders no button: the header never offers a dead control.
 */
import {
    CalendarCheck, ClipboardList, FileCheck, FileDown, FolderArchive, Plus, RefreshCw, Rows3, ShieldCheck,
    Sprout, Timer, TriangleAlert,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React from 'react';
import type { ComponentType, ReactNode } from 'react';
import { countFor } from '../data/useComplianceCounts';
import { dpiaRows } from '../pages/DpiaPage';
import { DAY_MS } from '../railMeta';
import { formatDay } from '../shared/formatDates';
import StatusPillJs from '../shared/StatusPill';
import { ExportMenu, InfoChip, PrimaryButton, SecondaryButton } from './headerParts';
import type { ExportItem } from './headerParts';

export type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;
type Tone = 'success' | 'warning' | 'error' | 'neutral';

// StatusPill is .jsx: its props without defaults would type as required.
const StatusPill = StatusPillJs as unknown as ComponentType<{ tone?: Tone; icon?: LucideIcon; testId?: string; children: ReactNode }>;

export interface HeaderSpec {
    pill: ReactNode;
    infoChip: ReactNode;
    secondary: ReactNode;
    primary: ReactNode;
    tabCounts?: Record<string, number | undefined>;
}

export interface HeaderAction {
    label: string;
    icon?: LucideIcon;
    onClick: () => void;
    disabled?: boolean;
}

type Handler = (() => void) | null | undefined;
type Rows = unknown[] | null | undefined;

export interface HeaderCtx {
    section?: { id: string };
    counts?: Record<string, unknown> | null;
    core?: { checks?: unknown[] } | null;
    dl?: (url: string) => string | null | undefined;
    api?: string;
    locale?: string;
    dsr?: { requests?: Rows; refresh?: Handler } | null;
    incidents?: { refresh?: Handler } | null;
    vulnerabilities?: { refresh?: Handler } | null;
    soa?: { soa?: { stats?: { approved?: number; total?: number; todo?: number } } | null; seed?: Handler } | null;
    audit?: { audits?: Rows; reviews?: Rows; ncs?: Array<{ status?: string }> | null; objectives?: Rows } | null;
    policies?: { docs?: { documents?: Array<{ status?: string }> } | null } | null;
    dpia?: { dpiaList?: unknown } | null;
    ropa?: { refresh?: Handler } | null;
    onCaptureRequest?: Handler;
    onRecordIncident?: Handler;
    onRecordVulnerability?: Handler;
    onAddRisk?: Handler;
    onSeedRisks?: Handler;
    onMarkRopaReviewed?: Handler;
    onRegenerateRopa?: Handler;
    ropaBusy?: boolean;
    portabilityCoverage?: { portable: number; total: number } | null;
    onRefreshPortability?: Handler;
    onAddFramework?: Handler;
    onRefreshMachinery?: Handler;
    primaryAction?: HeaderAction | null;
}

export type SpecFn = (ctx: HeaderCtx, t: Translate, base: HeaderSpec) => HeaderSpec;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (counts: HeaderCtx['counts'], path: string): number | undefined => {
    const v: unknown = countFor(counts, path);
    return isNum(v) ? v : undefined;
};

/** The product's ROPA cadence (GDPR-Art30-ropa-reviewed fails after a year), as in railMeta. */
const ROPA_REVIEW_MS = 365 * DAY_MS;

/** The rail's urgency rule for a clock: due or past → error, a day or less → warning. */
export function clockTone(hours: number): Tone {
    if (hours <= 0) return 'error';
    return hours <= 24 ? 'warning' : 'neutral';
}

/** The name of each incident clock (counts `incidents.next_stage`). */
const STAGE_LABEL: Record<string, (t: Translate) => string> = {
    early_warning: (t) => t('compliance.hdr_inc_stage_early_warning', 'early warning'),
    authority: (t) => t('compliance.hdr_inc_stage_authority', 'authority notice'),
    final_report: (t) => t('compliance.hdr_inc_stage_final_report', 'final report'),
    customer_notice: (t) => t('compliance.hdr_inc_stage_customer_notice', 'customer notice'),
};

/** '2 open · authority notice in 5 h': the clock the register's most urgent row shows. */
export function incidentPillText(n: number, hours: number | undefined, stage: unknown, t: Translate): string {
    if (!isNum(hours)) return t('compliance.hdr_open_count', '{n} open', { n });
    const name = typeof stage === 'string' && STAGE_LABEL[stage] ? STAGE_LABEL[stage](t) : null;
    if (!name) return t('compliance.hdr_inc_open', '{n} open · {hours} h to the deadline', { n, hours: Math.max(0, hours) });
    return hours < 0
        ? t('compliance.hdr_inc_open_stage_overdue', '{n} open · {stage} {hours} h overdue', { n, stage: name, hours: -hours })
        : t('compliance.hdr_inc_open_stage', '{n} open · {stage} in {hours} h', { n, stage: name, hours });
}

/** 'Reviewed 3 Mar', 'Review overdue' or 'Never reviewed'. */
export function ropaPill(lastReviewedAt: unknown, t: Translate, { locale = 'en', now = Date.now() }: { locale?: string; now?: number } = {}): ReactNode {
    const at = typeof lastReviewedAt === 'string' ? new Date(lastReviewedAt).getTime() : NaN;
    if (!Number.isFinite(at)) {
        return <StatusPill tone="warning" icon={TriangleAlert} testId="header-pill">{t('compliance.hdr_ropa_never', 'Never reviewed')}</StatusPill>;
    }
    if (now - at > ROPA_REVIEW_MS) {
        return <StatusPill tone="warning" icon={TriangleAlert} testId="header-pill">{t('compliance.hdr_ropa_review_due', 'Review overdue')}</StatusPill>;
    }
    return (
        <StatusPill tone="neutral" icon={CalendarCheck} testId="header-pill">
            {t('compliance.hdr_ropa_reviewed', 'Reviewed {date}', { date: formatDay(lastReviewedAt as string, locale, now) })}
        </StatusPill>
    );
}

/** The SoA downloads that are live: the Export tab's two links, through `dl`. */
export function soaExportItems(ctx: HeaderCtx, t: Translate): ExportItem[] {
    const { dl, api } = ctx;
    const items = [
        { id: 'soa_pdf', href: dl?.(`${api}/iso/soa.pdf`), label: t('compliance.hdr_soa_pdf', 'SoA (PDF)'), icon: FileDown },
        { id: 'bundle', href: dl?.(`${api}/iso/evidence-bundle.zip`), label: t('compliance.hdr_export_bundle', 'Evidence bundle (zip)'), icon: FolderArchive },
    ];
    return items.flatMap(({ href, ...rest }) => (typeof href === 'string' && href ? [{ ...rest, href }] : []));
}

/** The generic primary a page sets through `primaryAction`, or nothing. */
function actionPrimary(ctx: HeaderCtx): ReactNode {
    const a = ctx.primaryAction;
    if (!a || typeof a.onClick !== 'function') return null;
    return <PrimaryButton onClick={a.onClick} icon={a.icon} disabled={!!a.disabled}>{a.label}</PrimaryButton>;
}

// The spec's slot stays null without a handler, so `secondary` never holds a
// button that renders nothing (SecondaryButton refuses a dead one anyway).
const refreshButton = (onClick: Handler, t: Translate, label = t('compliance.hdr_refresh', 'Refresh')) => (
    onClick ? <SecondaryButton onClick={onClick} icon={RefreshCw} ariaLabel={label} /> : null
);
const EMPTY = { pill: null, infoChip: null, secondary: null, primary: null };

export const REGISTER_SPECS: Record<string, SpecFn> = {
    dsr(ctx, t) {
        const overdue = num(ctx.counts, 'dsr.overdue');
        const total = Array.isArray(ctx.dsr?.requests) ? ctx.dsr.requests.length : undefined;
        let pill: ReactNode = null;
        if (isNum(overdue) && overdue > 0) {
            pill = <StatusPill tone="error" icon={Timer} testId="header-pill">{t('compliance.hdr_dsr_overdue', '{n} past the deadline', { n: overdue })}</StatusPill>;
        } else if (total !== undefined) {
            pill = <StatusPill tone="neutral" testId="header-pill">{t('compliance.hdr_dsr_ok', 'All requests within the deadline')}</StatusPill>;
        }
        return {
            pill,
            infoChip: <InfoChip icon={Timer}>{t('compliance.hdr_dsr_window', 'Art. 12–22 · 30 days, +60 with reason')}</InfoChip>,
            secondary: refreshButton(ctx.dsr?.refresh, t, t('compliance.dsr_refresh', 'Refresh')),
            primary: ctx.onCaptureRequest ? <PrimaryButton onClick={ctx.onCaptureRequest} icon={Plus}>{t('compliance.dsr_capture_cta', 'Record a request')}</PrimaryButton> : null,
            tabCounts: { requests: total },
        };
    },
    incidents(ctx, t) {
        const open = num(ctx.counts, 'incidents.open');
        const hours = num(ctx.counts, 'incidents.hours_left');
        let pill: ReactNode = null;
        if (isNum(open) && open > 0) {
            pill = (
                <StatusPill tone={isNum(hours) ? clockTone(hours) : 'neutral'} icon={Timer} testId="header-pill">
                    {incidentPillText(open, hours, countFor(ctx.counts, 'incidents.next_stage'), t)}
                </StatusPill>
            );
        } else if (open === 0) {
            pill = <StatusPill tone="neutral" testId="header-pill">{t('compliance.hdr_inc_none', 'No incident running')}</StatusPill>;
        }
        return {
            pill,
            infoChip: <InfoChip icon={Timer}>{t('compliance.hdr_inc_window', 'Art. 33 · 72 hours to the authority')}</InfoChip>,
            secondary: refreshButton(ctx.incidents?.refresh, t),
            primary: ctx.onRecordIncident ? <PrimaryButton onClick={ctx.onRecordIncident} icon={Plus}>{t('compliance.inc_record', 'Record incident')}</PrimaryButton> : null,
        };
    },
    vulnerabilities(ctx, t) {
        const open = num(ctx.counts, 'incidents.vulnerabilities_open');
        let pill: ReactNode = null;
        if (isNum(open) && open > 0) pill = <StatusPill tone="error" icon={TriangleAlert} testId="header-pill">{t('compliance.hdr_open_count', '{n} open', { n: open })}</StatusPill>;
        else if (open === 0) pill = <StatusPill tone="neutral" testId="header-pill">{t('compliance.hdr_vuln_none', 'No vulnerability being reported')}</StatusPill>;
        return {
            pill,
            infoChip: <InfoChip icon={ShieldCheck}>{t('compliance.hdr_vuln_window', 'CRA Art. 14 · 24 h · 72 h · 14 days')}</InfoChip>,
            secondary: refreshButton(ctx.vulnerabilities?.refresh, t),
            primary: ctx.onRecordVulnerability ? <PrimaryButton onClick={ctx.onRecordVulnerability} icon={Plus}>{t('compliance.vuln_record', 'Record vulnerability')}</PrimaryButton> : null,
        };
    },
    ropa(ctx, t) {
        const ropa = countFor(ctx.counts, 'ropa') as { last_reviewed_at?: unknown } | undefined;
        return {
            pill: ropa && typeof ropa === 'object' ? ropaPill(ropa.last_reviewed_at, t, { locale: ctx.locale }) : null,
            infoChip: null,
            secondary: refreshButton(ctx.onRegenerateRopa || ctx.ropa?.refresh, t, t('compliance.hdr_ropa_regenerate', 'Regenerate from live configuration')),
            primary: ctx.onMarkRopaReviewed
                ? <PrimaryButton onClick={ctx.onMarkRopaReviewed} disabled={!!ctx.ropaBusy} icon={CalendarCheck}>{t('compliance.hdr_ropa_mark_reviewed', 'Mark as reviewed')}</PrimaryButton>
                : null,
        };
    },
    risks(ctx, t) {
        const total = num(ctx.counts, 'risks.total');
        const high = num(ctx.counts, 'risks.high') ?? 0;
        return {
            pill: isNum(total) ? (
                <StatusPill tone={high > 0 ? 'warning' : 'neutral'} testId="header-pill">{high > 0
                    ? t('compliance.hdr_risk_high', '{n} high · {total} in the register', { n: high, total })
                    : t('compliance.hdr_risk_total', '{n} in the register', { n: total })}</StatusPill>
            ) : null,
            infoChip: <InfoChip icon={ShieldCheck}>{t('compliance.hdr_risk_clause', 'ISO/IEC 27001 · 6.1.2 / 6.1.3')}</InfoChip>,
            secondary: ctx.onSeedRisks ? <SecondaryButton onClick={ctx.onSeedRisks} icon={Sprout}>{t('compliance.risk_seed_button', 'Seed suggested risks')}</SecondaryButton> : null,
            primary: ctx.onAddRisk ? <PrimaryButton onClick={ctx.onAddRisk} icon={Plus}>{t('compliance.risk_add', 'Add risk')}</PrimaryButton> : null,
        };
    },
    /**
     * SoA: the two downloads of the Export tab sit behind ONE "Export" menu,
     * with the tab's intro sentence above them. With downloads off the button
     * stays (disabled) and its tooltip says why, instead of a dead link.
     */
    soa(ctx, t) {
        const stats = ctx.soa?.soa?.stats;
        const approved = num(ctx.counts, 'soa.approved') ?? stats?.approved;
        const total = num(ctx.counts, 'soa.total') ?? stats?.total;
        const todo = stats?.todo;
        return {
            pill: isNum(approved) && isNum(total) ? (
                <StatusPill tone="neutral" testId="header-pill">
                    {t('compliance.hdr_soa_progress', '{approved} of {total} approved', { approved, total })}
                    {isNum(todo) ? ` · ${t('compliance.hdr_soa_todo', '{n} to review', { n: todo })}` : ''}
                </StatusPill>
            ) : null,
            infoChip: <InfoChip icon={ShieldCheck}>{`ISO/IEC 27001:2022 · ${t('compliance.hdr_soa_annex', 'Annex A')}`}</InfoChip>,
            secondary: ctx.soa?.seed ? <SecondaryButton onClick={ctx.soa.seed} icon={Rows3}>{t('compliance.hdr_soa_seed', 'Fill missing rows')}</SecondaryButton> : null,
            primary: ctx.api ? (
                <ExportMenu label={t('compliance.hdr_export', 'Export')} icon={FileDown} items={soaExportItems(ctx, t)}
                    description={t('compliance.soa_export_intro', 'The SoA PDF lists all 93 Annex A decisions with justification, owner and the who/when stamp; the evidence bundle adds the signed check results.')}
                    disabledReason={t('compliance.hdr_downloads_off', 'Downloads are switched off in this workspace')} />
            ) : null,
            tabCounts: { controls: total },
        };
    },
    /**
     * Audits: the page draws its own toolbars, so the header counts the four
     * registers behind the tabs. `audit.audits` is `null` until the one read
     * lands while the other three default to `[]`, so the whole set is gated
     * on it: an unread register shows nothing, never three zeros. The `ncs`
     * tab counts the OPEN non-conformities, the count that matters.
     */
    audits(ctx) {
        const audit = ctx.audit || {};
        const loaded = Array.isArray(audit.audits);
        return {
            ...EMPTY,
            primary: actionPrimary(ctx),
            tabCounts: loaded ? {
                audits: (audit.audits as unknown[]).length,
                reviews: Array.isArray(audit.reviews) ? audit.reviews.length : undefined,
                ncs: Array.isArray(audit.ncs) ? audit.ncs.filter(n => n.status !== 'closed').length : undefined,
                objectives: Array.isArray(audit.objectives) ? audit.objectives.length : undefined,
            } : {},
        };
    },
    /** Policies: how much of the ISMS document set is actually published. */
    policies(ctx, t) {
        const docs = ctx.policies?.docs;
        const documents = docs && Array.isArray(docs.documents) ? docs.documents : null;
        return {
            ...EMPTY,
            infoChip: documents ? (
                <InfoChip icon={FileCheck}>{t('compliance.hdr_pol_published', '{n} published of {total}', {
                    n: documents.filter(d => d.status === 'published').length, total: documents.length,
                })}</InfoChip>
            ) : null,
            primary: actionPrimary(ctx),
        };
    },
    training(ctx) {
        return { ...EMPTY, primary: actionPrimary(ctx) };
    },
    /**
     * DPIA: how many of the high-risk agents have an assessment on record.
     * The rows are derived exactly as the page derives them, so the pill and
     * the table never disagree; before the reads land there are no rows and
     * the pill renders nothing.
     */
    dpia(ctx, t) {
        const rows = dpiaRows(ctx.core?.checks, ctx.dpia?.dpiaList) as Array<{ dpia?: unknown }>;
        const done = rows.filter(r => r.dpia).length;
        return {
            ...EMPTY,
            pill: rows.length ? (
                <StatusPill tone={done === rows.length ? 'success' : 'warning'} icon={ClipboardList} testId="header-pill">
                    {t('compliance.hdr_dpia_progress', '{n} of {total} agents assessed', { n: done, total: rows.length })}
                </StatusPill>
            ) : null,
        };
    },
    portability(ctx, t) {
        const cov = ctx.portabilityCoverage;
        return {
            ...EMPTY,
            pill: cov && isNum(cov.total) && cov.total > 0 ? (
                <StatusPill tone={cov.portable === cov.total ? 'success' : 'warning'} testId="header-pill">
                    {t('compliance.hdr_portability_coverage', '{n} of {total} kinds portable', { n: cov.portable, total: cov.total })}
                </StatusPill>
            ) : null,
            secondary: refreshButton(ctx.onRefreshPortability, t),
        };
    },
    custom(ctx, t, base) {
        return {
            ...base,
            primary: ctx.onAddFramework
                ? <PrimaryButton onClick={ctx.onAddFramework} icon={Plus}>{t('compliance.hdr_custom_new', 'New framework')}</PrimaryButton>
                : base.primary,
        };
    },
    machinery(ctx, t, base) {
        return {
            ...base,
            primary: ctx.onRefreshMachinery
                ? <PrimaryButton onClick={ctx.onRefreshMachinery} icon={RefreshCw}>{t('compliance.hdr_machinery_scan', 'Scan again')}</PrimaryButton>
                : base.primary,
        };
    },
};
