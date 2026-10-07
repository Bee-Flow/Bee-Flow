/**
 * MobileHomeOverview — the "Overzicht" segment of the phone frame (artboard
 * 1h): the framework score rows, the Needs-attention list and the running
 * deadlines, stacked as cards with rows of at least 44px.
 *
 * Every number comes from the hub's data object as-is. A count the server
 * has not stated (`undefined`) renders nothing, a list that is `null` renders
 * its loading/failed state — never an empty card that pretends "0".
 *
 * Attention and deadline rows navigate with the SAME target the server
 * computed for the desktop list (`action.target` / `target` =
 * 'admin/compliance/<section>[/<id>][?tab=]', resolved by data/actions.js
 * `resolveTarget`, legacy tabs included); a check item without one falls back
 * to the section that scores its first framework, with the check code as the
 * focus id.
 */
import { ChevronRight } from 'lucide-react';
import React from 'react';
import { MobileCard, MOBILE_ROW_CLASS } from './MobileRailList';
import { useTranslation } from '../../../../hooks/useTranslation';
import DeadlineClock from '../../../shared/DeadlineClock';
import NavCountBadge from '../../../shared/NavCountBadge';
import {
    TONES, toneOfScore, toneOfCheckStatus, glyphOfCheckStatus, headlineKeyOfScore, HEADLINE_FALLBACK,
} from '../../../shared/statusTone';
import { visibleSections } from '../ComplianceRail';
import { complianceActionPath, resolveTarget } from '../data/actions';
import { openChecksFor } from '../data/openChecks';
import { countFor } from '../data/useComplianceCounts';
import { targetOf } from '../pages/overview/DeadlinesCard';
import { railScore } from '../railMeta';
import { sectionsInGroup, sectionForRegulation } from '../sections';
import ScoreRing from '../shared/ScoreRing';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** The framework id the counts object keys a section's score under. */
export function frameworkIdOf(section) {
    return section.id === 'iso' ? 'iso27001' : section.id;
}

/**
 * Where an attention row goes: `{ section, id, tab }` from the server's target
 * path, else the section scoring the item's first framework + its code.
 */
export function attentionTarget(item) {
    const target = item?.action?.target;
    if (typeof target === 'string' && target) {
        const hit = resolveTarget(complianceActionPath(target) || '');
        if (hit) return { section: hit.section, id: hit.id ?? null, tab: hit.tab };
    }
    const regulation = item?.meta?.frameworks?.[0]?.regulation || null;
    return { section: sectionForRegulation(regulation), id: item?.source === 'check' ? (item.code || item.id || null) : null };
}

function attentionMeta(item, t) {
    const parts = [];
    for (const f of item?.meta?.frameworks || []) {
        if (f?.regulation || f?.ref) parts.push([f.regulation, f.ref].filter(Boolean).join(' '));
    }
    const sev = item?.meta?.severity || item?.severity;
    if (sev) parts.push(t(`compliance.sev_${sev}`, sev));
    const ver = item?.meta?.verification;
    if (ver) parts.push(t(`compliance.verification_${ver}`, ver));
    return parts.join(' · ');
}

function Head({ children, right }) {
    return (
        <div className="flex items-center gap-2 px-0.5">
            <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{children}</span>
            {right}
        </div>
    );
}

function Note({ children, tone = 'neutral', testId }) {
    return (
        <div data-testid={testId} className="px-3.5 py-3 text-[12px]" style={{ color: tone === 'error' ? TONES.error.ink : 'var(--text-tertiary)' }}>
            {children}
        </div>
    );
}

export default function MobileHomeOverview({ data, navigate }) {
    const { t } = useTranslation();
    const counts = data?.counts || null;
    const checks = data?.core?.checks;
    const frameworks = data?.frameworks;

    const fwSections = visibleSections(sectionsInGroup('frameworks'), { counts, frameworks }).filter(s => !!s.regulation);
    const attention = data?.attention || {};
    const deadlines = data?.deadlines || {};
    const attentionOpen = countFor(counts, 'attention_open');
    const runningDeadlines = Array.isArray(deadlines.items)
        ? deadlines.items.filter(d => d?.state !== 'done' && d?.state !== 'none')
        : null;

    return (
        <div data-testid="mobile-home-overview" className="flex flex-col gap-3">
            {/* ── Framework scores ── */}
            <MobileCard testId="mobile-framework-card">
                {fwSections.map((s) => {
                    const score = railScore(counts, frameworkIdOf(s));
                    const tone = toneOfScore(score);
                    const key = headlineKeyOfScore(score);
                    const open = openChecksFor(checks, s.regulation);
                    const ink = TONES[tone].ink;
                    return (
                        <button key={s.id} type="button" data-testid={`mobile-fw-${s.id}`}
                            onClick={() => navigate(s.id)} className={`${MOBILE_ROW_CLASS} border-b last:border-b-0`}
                            style={{ borderColor: 'var(--border-default)' }}>
                            <ScoreRing score={score} size={36} tone={tone} label={t(s.labelKey, s.labelFallback)} testId={`mobile-fw-ring-${s.id}`} />
                            <span className="flex-1 min-w-0">
                                <span className="block text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                                    {t(s.labelKey, s.labelFallback)}
                                </span>
                                <span className="block text-[11px] truncate" style={{ color: ink }}>
                                    {t(key, HEADLINE_FALLBACK[key])}
                                    {isNum(open) && open > 0 ? ` · ${open}` : ''}
                                </span>
                            </span>
                            <ChevronRight size={16} aria-hidden="true" className="flex-shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                        </button>
                    );
                })}
            </MobileCard>

            {/* ── Needs attention ── */}
            <Head right={<NavCountBadge tone="warning" count={attentionOpen} testId="mobile-attention-count" />}>
                {t('compliance.mob_needs_attention', 'Needs attention')}
            </Head>
            <MobileCard testId="mobile-attention-card">
                {attention.items === null || attention.items === undefined ? (
                    attention.failed
                        ? <Note tone="error" testId="mobile-attention-failed">{t('compliance.mob_attention_failed', 'Could not load the open items.')}</Note>
                        : <Note testId="mobile-attention-loading">{t('compliance.mob_loading', 'Loading…')}</Note>
                ) : attention.items.length === 0 ? (
                    <Note testId="mobile-attention-empty">{t('compliance.mob_attention_empty', 'Nothing needs attention right now.')}</Note>
                ) : attention.items.map((item) => {
                    const tone = toneOfCheckStatus(item.status);
                    const Glyph = glyphOfCheckStatus(item.status);
                    const target = attentionTarget(item);
                    const meta = attentionMeta(item, t);
                    return (
                        <button key={item.id} type="button" data-testid={`mobile-attention-${item.id}`}
                            onClick={() => navigate(target.section, target.id || undefined, target.tab)}
                            className={`${MOBILE_ROW_CLASS} border-b last:border-b-0`} style={{ borderColor: 'var(--border-default)' }}>
                            <Glyph size={16} aria-hidden="true" className="flex-shrink-0" style={{ color: TONES[tone].ink }} />
                            <span className="flex-1 min-w-0">
                                <span className="block text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{item.title}</span>
                                {meta && <span className="block text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>{meta}</span>}
                            </span>
                            <ChevronRight size={16} aria-hidden="true" className="flex-shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                        </button>
                    );
                })}
            </MobileCard>

            {/* ── Deadlines ── */}
            <Head right={runningDeadlines ? (
                <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                    {t('compliance.mob_deadlines_running', '{n} running', { n: runningDeadlines.length })}
                </span>
            ) : null}>
                {t('compliance.mob_deadlines', 'Deadlines')}
            </Head>
            <MobileCard testId="mobile-deadlines-card">
                {runningDeadlines === null ? (
                    deadlines.failed
                        ? <Note tone="error" testId="mobile-deadlines-failed">{t('compliance.mob_deadlines_failed', 'Could not load the deadlines.')}</Note>
                        : <Note testId="mobile-deadlines-loading">{t('compliance.mob_loading', 'Loading…')}</Note>
                ) : runningDeadlines.length === 0 ? (
                    <Note testId="mobile-deadlines-empty">{t('compliance.mob_deadlines_empty', 'No running deadlines.')}</Note>
                ) : runningDeadlines.map((d) => {
                    const target = targetOf(d);
                    const kindLabel = d.kind ? t(`compliance.deadline_kind_${d.kind}`, d.kind) : null;
                    const meta = [kindLabel, d.meta?.article ? t('compliance.mob_article', 'Art. {ref}', { ref: d.meta.article }) : null].filter(Boolean).join(' · ');
                    const title = [d.ref, d.title].filter(Boolean).join(' · ');
                    return (
                        <button key={d.id} type="button" data-testid={`mobile-deadline-${d.id}`}
                            onClick={() => { if (target?.section) navigate(target.section, target.id || undefined, target.tab); }}
                            className={`${MOBILE_ROW_CLASS} border-b last:border-b-0`} style={{ borderColor: 'var(--border-default)' }}>
                            <span className="flex-1 min-w-0">
                                <span className="block text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{title}</span>
                                {meta && <span className="block text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>{meta}</span>}
                            </span>
                            <DeadlineClock variant="row" dueAt={d.due_at} startedAt={d.started_at} state={d.state} pct={d.pct}
                                className="w-[104px] flex-shrink-0" testId={`mobile-deadline-clock-${d.id}`} />
                        </button>
                    );
                })}
            </MobileCard>
        </div>
    );
}
