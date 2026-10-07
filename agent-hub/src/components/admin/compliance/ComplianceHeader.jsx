/**
 * ComplianceHeader — the 48 px section header of every Compliance page
 * (artboards 1a–1e, redesign Sep 2026), composed on the shared
 * StudioSectionHeader: kind tile · title · status pill · centred tabs ·
 * info chip + secondary · primary.
 *
 * What differs per section is a SPEC, not a component: `HEADER_SPECS[id]`
 * (or the framework default) answers `(ctx, t, base) → { pill, infoChip,
 * secondary, primary, tabCounts }`. The register specs live in
 * header/registerSpecs.tsx, the buttons and the info chip in
 * header/headerParts.tsx; this file keeps the overview, the frameworks list,
 * the framework default and the layout.
 *
 * Fit. The header sits beside the 300px rail, so it is narrower than the
 * window: it asks StudioSectionHeader for the compact tab fold (the strip
 * holds until the header itself is 900px wide) and a title that never
 * collapses. Below 1180px info chips and secondary labels fold to icons
 * (headerParts). On the phone (`layout="phone"`) the actions move to a
 * second, wrapping row under the title bar, so the primary is always on
 * screen.
 *
 * Rules the primary obeys (StudioSectionHeader docblock): it is a
 * PRIMARY_ACTION_STYLE button — never an ink-filled block. Pills use
 * StatusPill (border = raw tone, text = ink). Counts on tabs go through
 * `countFor` and render nothing while unknown. A download renders only when
 * `dl` returned a link: with exports off there is no dead button.
 */
import { CircleCheck, FileDown, Play, Plus, RefreshCw, ListTodo, TriangleAlert, Timer, CalendarCheck, Calendar } from 'lucide-react';
import React from 'react';
import { countFor } from './data/useComplianceCounts';
import { InfoChip, PrimaryButton, SecondaryButton } from './header/headerParts';
import { REGISTER_SPECS } from './header/registerSpecs';
import { formatClock, railScore } from './railMeta';
import { tabLabelKey, frameworkOf } from './sections';
import StatusPill from './shared/StatusPill';
import { useTranslation } from '../../../hooks/useTranslation';
import { toneOfScore, headlineKeyOfScore, HEADLINE_FALLBACK } from '../../shared/statusTone';
import StudioSectionHeader from '../../shared/StudioSectionHeader';

export { HEADER_BUTTON, PrimaryButton, SecondaryButton, InfoChip } from './header/headerParts';

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

/** The worst score over EVERY framework the counts report (DORA, NIS2, … too), or undefined. */
export function worstScore(counts) {
    const fws = countFor(counts, 'frameworks');
    if (!fws || typeof fws !== 'object') return undefined;
    const scores = Object.values(fws).map(f => f?.score).filter(s => typeof s === 'number' && Number.isFinite(s));
    return scores.length ? Math.min(...scores) : undefined;
}

const upcomingCount = (calendar) => (calendar?.milestones || []).filter(m => m.date && new Date(m.date) > new Date()).length || undefined;

/**
 * Default spec for a framework section: score pill · in-force chip · run
 * again. No report download: the framework report is the org-wide
 * /report.pdf, which stays in the Overview header, Overview › Reports and the
 * rail's download button.
 */
function frameworkSpec(ctx, t) {
    const { section, counts, core, frameworks } = ctx;
    const fwId = section.id === 'iso' ? 'iso27001' : section.id;
    const score = railScore(counts, fwId) ?? (section.id === 'gdpr' ? core?.overview?.gdpr?.score : section.id === 'aia' ? core?.overview?.aia?.score : undefined);
    const since = frameworks?.byId?.(fwId)?.in_force_since;
    const regulation = frameworkOf(section.id);
    return {
        pill: score === undefined ? null : (
            <StatusPill tone={toneOfScore(score)} testId="header-pill">{score} · {scoreHeadline(t, score)}</StatusPill>
        ),
        infoChip: since ? <InfoChip icon={CalendarCheck}>{t('compliance.hdr_in_force_since', 'In force since {date}', { date: since })}</InfoChip> : null,
        secondary: null,
        primary: core ? <PrimaryButton onClick={core.runNow} disabled={core.running} icon={RefreshCw}>{t('compliance.hdr_run_again', 'Run again')}</PrimaryButton> : null,
        tabCounts: { checks: (core?.checks || []).filter(c => c.regulation === regulation || c.frameworks?.some(f => f.regulation === regulation)).length || undefined,
            evidence: countFor(counts, `evidence.by_framework.${fwId}`) },
    };
}

/** "15 open", toned by the worst framework, with a check only when all is green. */
function overviewPill(ctx, t) {
    const { counts, core } = ctx;
    if (core?.onboarded === false) {
        const step = countFor(counts, 'setup_step');
        return <StatusPill tone="neutral" icon={ListTodo} testId="header-pill">{t('compliance.setup_pill', 'Setup · step {step} of {total}', { step: typeof step === 'number' ? step : 1, total: 4 })}</StatusPill>;
    }
    const attention = countFor(counts, 'attention_open');
    if (typeof attention !== 'number') return null;
    const worst = worstScore(counts);
    const tone = worst === undefined ? 'neutral' : toneOfScore(worst);
    const icon = tone === 'success' ? CircleCheck : tone === 'neutral' ? undefined : TriangleAlert;
    return <StatusPill tone={tone} icon={icon} testId="header-pill">{t('compliance.hdr_open_count', '{n} open', { n: attention })}</StatusPill>;
}

/** "Last run 09:12 · every 6 h"; folded, only the time stays next to the icon. */
function lastRunChip(ctx, t) {
    const lastAt = countFor(ctx.counts, 'last_run.at') || ctx.core?.overview?.last_run_at;
    const time = formatClock(lastAt, ctx.locale);
    if (!time) return null;
    const every = countFor(ctx.counts, 'last_run.interval_hours');
    return (
        <InfoChip icon={Timer} short={time}>{every
            ? t('compliance.hdr_last_run_every', 'Last run {time} · every {hours} h', { time, hours: every })
            : t('compliance.hdr_last_run', 'Last run {time}', { time })}</InfoChip>
    );
}

export const HEADER_SPECS = {
    ...REGISTER_SPECS,
    overview(ctx, t) {
        const { core, dl, api } = ctx;
        const onboarded = core?.onboarded;
        const report = onboarded !== false && api ? dl?.(`${api}/report.pdf`) : null;
        return {
            pill: overviewPill(ctx, t),
            infoChip: lastRunChip(ctx, t),
            secondary: report ? <SecondaryButton href={report} download icon={FileDown}>{t('compliance.hdr_report_pdf', 'Report (PDF)')}</SecondaryButton> : null,
            primary: core ? (
                <PrimaryButton onClick={core.runNow} disabled={core.running || onboarded === false} icon={Play}
                    title={onboarded === false ? t('compliance.hdr_run_after_setup', 'Available after setup') : undefined}>
                    {core.running ? t('compliance.running', 'Running…') : t('compliance.hdr_run_now', 'Run now')}
                </PrimaryButton>
            ) : null,
            tabCounts: { calendar: upcomingCount(ctx.calendar) },
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
            tabCounts: { calendar: upcomingCount(ctx.calendar) },
        };
    },
};

const EMPTY_SPEC = Object.freeze({ pill: null, infoChip: null, secondary: null, primary: null, tabCounts: {} });

/** Resolve the spec for a section: its own entry (given the framework default as `base`), else that default. */
export function headerSpec(ctx, t) {
    const id = ctx.section?.id;
    const base = frameworkOf(id) ? frameworkSpec(ctx, t) : EMPTY_SPEC;
    return HEADER_SPECS[id] ? HEADER_SPECS[id](ctx, t, base) : base;
}

export default function ComplianceHeader({ section, tab, onTab, onBack, backLabel, ctx = {}, extraTabs = null, layout = 'desktop', testId = 'compliance-header' }) {
    const { t, resolvedLocale } = useTranslation();
    const spec = headerSpec({ locale: resolvedLocale, ...ctx, section }, t);
    const tabs = (section.tabs || []).map((id) => {
        const count = spec.tabCounts?.[id];
        return { id, label: t(tabLabelKey(section.id, id), id), count: typeof count === 'number' ? count : undefined };
    });
    const bar = {
        kind: 'compliance',
        icon: section.icon,
        title: t(section.labelKey, section.labelFallback),
        tabs: tabs.length ? [...tabs, ...(extraTabs || [])] : false,
        activeTab: tab,
        onTab,
        tabsFold: 'compact',
        onBack,
        backLabel,
    };
    if (layout === 'phone') {
        // Row 1 the title bar and the tab menu; row 2 everything else, wrapping.
        const actions = [spec.pill, spec.infoChip, spec.secondary, spec.primary].filter(Boolean);
        return (
            <div className="flex-shrink-0" data-testid={testId} data-layout="phone">
                <StudioSectionHeader {...bar} testId={`${testId}-bar`} />
                {actions.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--border-default)] bg-[var(--bg-secondary)]" data-testid={`${testId}-actions`}>
                        {spec.pill}{spec.infoChip}{spec.secondary}{spec.primary}
                    </div>
                )}
            </div>
        );
    }
    return (
        <StudioSectionHeader
            {...bar}
            titleMin
            statusChip={spec.pill || undefined}
            capsule={(spec.infoChip || spec.secondary) ? <>{spec.infoChip}{spec.secondary}</> : undefined}
            primary={spec.primary || undefined}
            testId={testId}
        />
    );
}
