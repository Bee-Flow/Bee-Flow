/**
 * ComplianceHeader — the 48 px section header of every Compliance page
 * (artboards 1a–1e, redesign Sep 2026), composed on the shared
 * StudioSectionHeader: kind tile · title · status pill · centred tabs ·
 * info chip + secondary · primary.
 *
 * What differs per section is a SPEC, not a component: `HEADER_SPECS[id]`
 * (or a default derived from the section record) answers `(ctx, t) → { pill,
 * infoChip, secondary, primary, tabCounts }`. Page streams extend the map
 * (their DONE files name the entries); the header itself stays one file.
 *
 * Rules the primary obeys (StudioSectionHeader docblock): it is a
 * PRIMARY_ACTION_STYLE button — never an ink-filled block. Pills use
 * StatusPill (border = raw tone, text = ink). Counts on tabs go through
 * `countFor` and render nothing while unknown.
 */
import React from 'react';
import { FileDown, Play, Plus, RefreshCw, Rows3, ListTodo, Sprout, TriangleAlert, Timer, CalendarCheck, Calendar, ShieldCheck, FileCheck, ClipboardList } from 'lucide-react';
import { useTranslation } from '../../../hooks/useTranslation';
import StudioSectionHeader, { PRIMARY_ACTION_STYLE } from '../../shared/StudioSectionHeader';
import StatusPill from './shared/StatusPill';
import { toneOfScore, headlineKeyOfScore, HEADLINE_FALLBACK } from '../../shared/statusTone';
import { tabLabelKey, frameworkOf } from './sections';
import { countFor } from './data/useComplianceCounts';
import { formatClock, railScore } from './railMeta';
import { dpiaRows } from './pages/DpiaPage';

export const HEADER_BUTTON = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-[12px] whitespace-nowrap';
const SECONDARY = `${HEADER_BUTTON} font-medium border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]`;
const INFO = `${HEADER_BUTTON} border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-secondary)]`;

export function PrimaryButton({ onClick, disabled, icon: Icon, children, title, testId = 'header-primary' }) {
    return (
        <button type="button" onClick={onClick} disabled={disabled} title={title} data-testid={testId}
            className={`${HEADER_BUTTON} font-semibold disabled:opacity-60 disabled:cursor-not-allowed`} style={PRIMARY_ACTION_STYLE}>
            {Icon && <Icon className="w-[13px] h-[13px]" aria-hidden="true" />}{children}
        </button>
    );
}
export function SecondaryButton({ onClick, href, download, icon: Icon, children, testId = 'header-secondary', ariaLabel }) {
    if (href) {
        return (
            <a href={href} download={download} className={SECONDARY} data-testid={testId} aria-label={ariaLabel}>
                {Icon && <Icon className="w-[13px] h-[13px]" aria-hidden="true" />}{children}
            </a>
        );
    }
    return (
        <button type="button" onClick={onClick} className={SECONDARY} data-testid={testId} aria-label={ariaLabel}>
            {Icon && <Icon className="w-[13px] h-[13px]" aria-hidden="true" />}{children}
        </button>
    );
}
export function InfoChip({ icon: Icon, children, testId = 'header-info', title = undefined, tone = undefined }) {
    return (
        <span className={tone === 'warning' ? `${INFO} text-[var(--warning-ink)]` : INFO} data-testid={testId} title={title} data-tone={tone}>
            {Icon && <Icon className="w-[13px] h-[13px]" aria-hidden="true" />}{children}
        </span>
    );
}

/**
 * The date the legal register was last checked against the official texts —
 * never today's date. The chip used to read "As of <today>", which presented
 * a catalogue written weeks earlier as current. Without a review from the
 * server (an older server) it falls back to that old wording.
 */
export function legalStatusChip(review, t) {
    if (!review) {
        return <InfoChip icon={Calendar}>{t('compliance.hdr_fw_asof', 'As of {date} · not legal advice', { date: new Date().toISOString().slice(0, 10) })}</InfoChip>;
    }
    const hint = t('compliance.hdr_fw_checked_hint', 'The frameworks, dates and milestones here were checked against the official texts. Each framework lists its sources under Timeline. Not legal advice.');
    if (!review.verified_on) {
        return <InfoChip icon={TriangleAlert} tone="warning" title={hint}>{t('compliance.hdr_fw_review_unknown', 'Legal status not recorded · due for review')}</InfoChip>;
    }
    if (review.stale) {
        return <InfoChip icon={TriangleAlert} tone="warning" title={hint}>{t('compliance.hdr_fw_review_due', 'Legal status checked {date} · due for review', { date: review.verified_on })}</InfoChip>;
    }
    return <InfoChip icon={CalendarCheck} title={hint}>{t('compliance.hdr_fw_checked', 'Legal status checked {date} · not legal advice', { date: review.verified_on })}</InfoChip>;
}

const scoreHeadline = (t, score) => t(headlineKeyOfScore(score), HEADLINE_FALLBACK[headlineKeyOfScore(score)]);

/** Default spec for a framework section: score pill · in-force chip · report · run again. */
function frameworkSpec(ctx, t) {
    const { section, counts, core, frameworks, dl, api } = ctx;
    const fwId = section.id === 'iso' ? 'iso27001' : section.id;
    const score = railScore(counts, fwId) ?? (section.id === 'gdpr' ? core?.overview?.gdpr?.score : section.id === 'aia' ? core?.overview?.aia?.score : undefined);
    const fw = frameworks?.byId?.(fwId);
    const since = fw?.in_force_since;
    return {
        pill: score === undefined ? null : (
            <StatusPill tone={toneOfScore(score)} testId="header-pill">{score} · {scoreHeadline(t, score)}</StatusPill>
        ),
        infoChip: since ? <InfoChip icon={CalendarCheck}>{t('compliance.hdr_in_force_since', 'In force since {date}', { date: since })}</InfoChip> : null,
        secondary: dl && api ? <SecondaryButton href={dl(`${api}/report.pdf`)} download icon={FileDown}>{t('compliance.hdr_report_pdf', 'Report (PDF)')}</SecondaryButton> : null,
        primary: core ? <PrimaryButton onClick={core.runNow} disabled={core.running} icon={RefreshCw}>{t('compliance.hdr_run_again', 'Run again')}</PrimaryButton> : null,
        tabCounts: { checks: (core?.checks || []).filter(c => c.regulation === frameworkOf(section.id) || c.frameworks?.some(f => f.regulation === frameworkOf(section.id))).length || undefined,
            evidence: countFor(counts, `evidence.by_framework.${fwId}`) },
    };
}

export const HEADER_SPECS = {
    overview(ctx, t) {
        const { counts, core, dl, api, calendar } = ctx;
        const onboarded = core?.onboarded;
        const attention = countFor(counts, 'attention_open');
        const scores = ['gdpr', 'aia', 'iso27001'].map(id => railScore(counts, id)).filter(s => typeof s === 'number');
        const worst = scores.length ? Math.min(...scores) : undefined;
        const step = countFor(counts, 'setup_step');
        const lastAt = countFor(counts, 'last_run.at') || core?.overview?.last_run_at;
        const every = countFor(counts, 'last_run.interval_hours');
        const upcoming = (calendar?.milestones || []).filter(m => m.date && new Date(m.date) > new Date()).length || undefined;
        return {
            pill: onboarded === false
                ? <StatusPill tone="neutral" icon={ListTodo} testId="header-pill">{t('compliance.setup_pill', 'Setup · step {step} of {total}', { step: typeof step === 'number' ? step : 1, total: 4 })}</StatusPill>
                : worst === undefined ? null
                    : <StatusPill tone={toneOfScore(worst)} icon={TriangleAlert} testId="header-pill">{scoreHeadline(t, worst)}{typeof attention === 'number' ? ` · ${t('compliance.hdr_open_count', '{n} open', { n: attention })}` : ''}</StatusPill>,
            infoChip: lastAt ? (
                <InfoChip icon={Timer}>{every
                    ? t('compliance.hdr_last_run_every', 'Last run {time} · every {hours} h', { time: formatClock(lastAt), hours: every })
                    : t('compliance.hdr_last_run', 'Last run {time}', { time: formatClock(lastAt) })}</InfoChip>
            ) : null,
            secondary: dl && api && onboarded !== false ? <SecondaryButton href={dl(`${api}/report.pdf`)} download icon={FileDown}>{t('compliance.hdr_report_pdf', 'Report (PDF)')}</SecondaryButton> : null,
            primary: core ? (
                <PrimaryButton onClick={core.runNow} disabled={core.running || onboarded === false} icon={Play}
                    title={onboarded === false ? t('compliance.hdr_run_after_setup', 'Available after setup') : undefined}>
                    {core.running ? t('compliance.running', 'Running…') : t('compliance.hdr_run_now', 'Run now')}
                </PrimaryButton>
            ) : null,
            tabCounts: { calendar: upcoming },
        };
    },
    frameworks(ctx, t) {
        const { counts, frameworks } = ctx;
        const active = countFor(counts, 'frameworks_summary.active') ?? frameworks?.active?.length;
        const cand = countFor(counts, 'frameworks_summary.candidates') ?? frameworks?.candidates?.length;
        const recent = countFor(counts, 'frameworks_summary.recently_in_force');
        return {
            pill: typeof active === 'number' && typeof cand === 'number'
                ? <StatusPill tone="neutral" testId="header-pill">{t('compliance.hdr_fw_summary', '{active} active · {candidates} candidates', { active, candidates: cand })}{typeof recent === 'number' && recent > 0 ? ` · ${t('compliance.hdr_fw_recent', '{n} just in force', { n: recent })}` : ''}</StatusPill>
                : null,
            infoChip: legalStatusChip(frameworks?.catalogue, t),
            secondary: null,
            primary: ctx.onAddFramework ? <PrimaryButton onClick={ctx.onAddFramework} icon={Plus}>{t('compliance.hdr_fw_add', 'Add framework')}</PrimaryButton> : null,
            tabCounts: { calendar: (ctx.calendar?.milestones || []).filter(m => m.date && new Date(m.date) > new Date()).length || undefined },
        };
    },
    dsr(ctx, t) {
        const { counts, dsr, dl } = ctx;
        const overdue = countFor(counts, 'dsr.overdue');
        const total = Array.isArray(dsr?.requests) ? dsr.requests.length : undefined;
        return {
            pill: typeof overdue === 'number' && overdue > 0
                ? <StatusPill tone="error" icon={Timer} testId="header-pill">{t('compliance.hdr_dsr_overdue', '{n} past the deadline', { n: overdue })}</StatusPill>
                : total !== undefined ? <StatusPill tone="neutral" testId="header-pill">{t('compliance.hdr_dsr_ok', 'All requests within the deadline')}</StatusPill> : null,
            infoChip: <InfoChip icon={Timer}>{t('compliance.hdr_dsr_window', 'Art. 12–22 · 30 days, +60 with reason')}</InfoChip>,
            secondary: dsr?.refresh ? <SecondaryButton onClick={dsr.refresh} icon={RefreshCw} ariaLabel={t('compliance.dsr_refresh', 'Refresh')} /> : null,
            primary: ctx.onCaptureRequest ? <PrimaryButton onClick={ctx.onCaptureRequest} icon={Plus}>{t('compliance.dsr_capture_cta', 'Record a request')}</PrimaryButton> : null,
            tabCounts: { requests: total },
            dl,
        };
    },
    incidents(ctx, t) {
        const { counts, incidents, onRecordIncident } = ctx;
        const open = countFor(counts, 'incidents.open');
        const hours = countFor(counts, 'incidents.hours_left');
        return {
            pill: typeof open === 'number'
                ? (open > 0
                    ? <StatusPill tone="error" icon={Timer} testId="header-pill">{typeof hours === 'number'
                        ? t('compliance.hdr_inc_open', '{n} open · {hours} h to the deadline', { n: open, hours })
                        : t('compliance.hdr_open_count', '{n} open', { n: open })}</StatusPill>
                    : <StatusPill tone="neutral" testId="header-pill">{t('compliance.hdr_inc_none', 'No incident running')}</StatusPill>)
                : null,
            infoChip: <InfoChip icon={Timer}>{t('compliance.hdr_inc_window', 'Art. 33 · 72 hours to the authority')}</InfoChip>,
            secondary: incidents?.refresh
                ? <SecondaryButton onClick={incidents.refresh} icon={RefreshCw} ariaLabel={t('compliance.hdr_refresh', 'Refresh')} /> : null,
            primary: onRecordIncident
                ? <PrimaryButton onClick={onRecordIncident} icon={Plus}>{t('compliance.inc_record', 'Record incident')}</PrimaryButton> : null,
        };
    },
    vulnerabilities(ctx, t) {
        const { counts, vulnerabilities, onRecordVulnerability } = ctx;
        const open = countFor(counts, 'incidents.vulnerabilities_open');
        return {
            pill: typeof open === 'number'
                ? (open > 0
                    ? <StatusPill tone="error" icon={TriangleAlert} testId="header-pill">{t('compliance.hdr_open_count', '{n} open', { n: open })}</StatusPill>
                    : <StatusPill tone="neutral" testId="header-pill">{t('compliance.hdr_vuln_none', 'No vulnerability being reported')}</StatusPill>)
                : null,
            infoChip: <InfoChip icon={ShieldCheck}>{t('compliance.hdr_vuln_window', 'CRA Art. 14 · 24 h · 72 h · 14 days')}</InfoChip>,
            secondary: vulnerabilities?.refresh
                ? <SecondaryButton onClick={vulnerabilities.refresh} icon={RefreshCw} ariaLabel={t('compliance.hdr_refresh', 'Refresh')} /> : null,
            primary: onRecordVulnerability
                ? <PrimaryButton onClick={onRecordVulnerability} icon={Plus}>{t('compliance.vuln_record', 'Record vulnerability')}</PrimaryButton> : null,
        };
    },
    risks(ctx, t) {
        const { counts, onAddRisk, onSeedRisks } = ctx;
        const total = countFor(counts, 'risks.total');
        const high = countFor(counts, 'risks.high');
        return {
            pill: typeof total === 'number'
                ? <StatusPill tone={high > 0 ? 'warning' : 'neutral'} testId="header-pill">{high > 0
                    ? t('compliance.hdr_risk_high', '{n} high · {total} in the register', { n: high, total })
                    : t('compliance.hdr_risk_total', '{n} in the register', { n: total })}</StatusPill>
                : null,
            infoChip: <InfoChip icon={ShieldCheck}>{t('compliance.hdr_risk_clause', 'ISO/IEC 27001 · 6.1.2 / 6.1.3')}</InfoChip>,
            secondary: onSeedRisks
                ? <SecondaryButton onClick={onSeedRisks} icon={Sprout}>{t('compliance.risk_seed_button', 'Seed suggested risks')}</SecondaryButton> : null,
            primary: onAddRisk
                ? <PrimaryButton onClick={onAddRisk} icon={Plus}>{t('compliance.risk_add', 'Add risk')}</PrimaryButton> : null,
        };
    },
    soa(ctx, t) {
        const { counts, soa, dl, api } = ctx;
        const approved = countFor(counts, 'soa.approved') ?? soa?.soa?.stats?.approved;
        const total = countFor(counts, 'soa.total') ?? soa?.soa?.stats?.total;
        const todo = soa?.soa?.stats?.todo;
        return {
            pill: typeof approved === 'number' && typeof total === 'number'
                ? <StatusPill tone="neutral" testId="header-pill">{t('compliance.hdr_soa_progress', '{approved} of {total} approved', { approved, total })}{typeof todo === 'number' ? ` · ${t('compliance.hdr_soa_todo', '{n} to review', { n: todo })}` : ''}</StatusPill>
                : null,
            infoChip: <InfoChip icon={ShieldCheck}>ISO/IEC 27001:2022 · {t('compliance.hdr_soa_annex', 'Annex A')}</InfoChip>,
            secondary: soa?.seed ? <SecondaryButton onClick={soa.seed} icon={Rows3}>{t('compliance.hdr_soa_seed', 'Fill missing rows')}</SecondaryButton> : null,
            primary: dl && api ? <a href={dl(`${api}/iso/soa.pdf`) || undefined} download className={`${HEADER_BUTTON} font-semibold`} style={PRIMARY_ACTION_STYLE} data-testid="header-primary"><FileDown className="w-[13px] h-[13px]" aria-hidden="true" />{t('compliance.hdr_soa_pdf', 'SoA (PDF)')}</a> : null,
            tabCounts: { controls: total },
        };
    },
    /**
     * Audits (fe-6) — the page draws its own toolbars, so the header only
     * counts the four registers behind the tabs. `audit.audits` is `null`
     * until the one read lands while the other three default to `[]`, so the
     * whole set is gated on that: an unread register shows nothing, never
     * three zeros. Open non-conformities is the count that matters, so the
     * `ncs` tab counts the open ones.
     */
    audits(ctx) {
        const audit = ctx.audit || {};
        const loaded = Array.isArray(audit.audits);
        return {
            pill: null, infoChip: null, secondary: null, primary: null,
            tabCounts: loaded ? {
                audits: audit.audits.length,
                reviews: Array.isArray(audit.reviews) ? audit.reviews.length : undefined,
                ncs: Array.isArray(audit.ncs) ? audit.ncs.filter(n => n.status !== 'closed').length : undefined,
                objectives: Array.isArray(audit.objectives) ? audit.objectives.length : undefined,
            } : {},
        };
    },
    /**
     * Policies (fe-6) — how much of the ISMS document set is actually
     * published. No primary: "Add the N missing templates" is contextual and
     * lives in the page toolbar.
     */
    policies(ctx, t) {
        const docs = ctx.policies?.docs;
        const documents = docs && Array.isArray(docs.documents) ? docs.documents : null;
        return {
            pill: null,
            infoChip: documents ? (
                <InfoChip icon={FileCheck}>{t('compliance.hdr_pol_published', '{n} published of {total}', {
                    n: documents.filter(d => d.status === 'published').length, total: documents.length,
                })}</InfoChip>
            ) : null,
            secondary: null, primary: null,
        };
    },
    /**
     * DPIA (fe-6) — how many of the high-risk agents have an assessment on
     * record. The rows are derived exactly as the page derives them, so the
     * pill and the table can never disagree; before the checks or the list
     * are read there are no rows and the pill renders nothing.
     */
    dpia(ctx, t) {
        const rows = dpiaRows(ctx.core?.checks, ctx.dpia?.dpiaList);
        const done = rows.filter(r => r.dpia).length;
        return {
            pill: rows.length ? (
                <StatusPill tone={done === rows.length ? 'success' : 'warning'} icon={ClipboardList} testId="header-pill">
                    {t('compliance.hdr_dpia_progress', '{n} of {total} agents assessed', { n: done, total: rows.length })}
                </StatusPill>
            ) : null,
            infoChip: null, secondary: null, primary: null,
        };
    },
};

/** Resolve the spec for a section: an explicit entry, else the framework default, else nothing. */
export function headerSpec(ctx, t) {
    const id = ctx.section?.id;
    if (HEADER_SPECS[id]) return HEADER_SPECS[id](ctx, t);
    if (frameworkOf(id)) return frameworkSpec(ctx, t);
    return { pill: null, infoChip: null, secondary: null, primary: null, tabCounts: {} };
}

export default function ComplianceHeader({ section, tab, onTab, onBack, backLabel, ctx = {}, extraTabs = null, testId = 'compliance-header' }) {
    const { t } = useTranslation();
    const spec = headerSpec({ ...ctx, section }, t);
    const tabs = (section.tabs || []).map((id) => {
        const count = spec.tabCounts?.[id];
        return { id, label: t(tabLabelKey(section.id, id), id), count: typeof count === 'number' ? count : undefined };
    });
    const title = section.regulation && ctx.frameworks?.byId
        ? (t(section.labelKey, section.labelFallback))
        : t(section.labelKey, section.labelFallback);
    return (
        <StudioSectionHeader
            kind="compliance"
            icon={section.icon}
            title={title}
            statusChip={spec.pill || undefined}
            tabs={tabs.length ? [...tabs, ...(extraTabs || [])] : false}
            activeTab={tab}
            onTab={onTab}
            capsule={(spec.infoChip || spec.secondary) ? <>{spec.infoChip}{spec.secondary}</> : undefined}
            primary={spec.primary || undefined}
            onBack={onBack}
            backLabel={backLabel}
            testId={testId}
        />
    );
}
