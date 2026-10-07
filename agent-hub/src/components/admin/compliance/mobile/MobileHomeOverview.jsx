/**
 * MobileHomeOverview — the "Overzicht" segment of the phone frame (artboard
 * 1h): the framework score rows, the Needs-attention list (five rows, then
 * "Show all {n}" inline, like the desktop list), the running deadlines, the
 * upcoming dates and two entry rows into the Overview's Calendar and Reports
 * tabs, stacked as cards with rows of at least 44px. Without those two rows
 * the calendar, the reports and the PDF were unreachable on a phone.
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
import { CalendarDays, ChevronDown, ChevronRight, FileDown } from 'lucide-react';
import React, { useId, useState } from 'react';
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
import { deadlineRef, deadlineSubjectKind, targetOf } from '../pages/overview/deadlineRows';
import UpcomingDatesCard from '../pages/overview/UpcomingDatesCard';
import { railScore } from '../railMeta';
import { sectionsInGroup, sectionForRegulation } from '../sections';
import { formatArticleRef } from '../shared/ArticleRef';
import ScoreRing from '../shared/ScoreRing';
import { VERIFICATION_KINDS } from '../shared/VerificationChip';

/** Attention rows before "Show all {n}" — the same five as the desktop list. */
const ATTENTION_FOLDED = 5;
/** References on a meta line before "+k". */
const MAX_REFS = 2;

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

/** "GDPR Art. 35 · Should fix · Self-attested": the desktop meta line as text. */
function attentionMeta(item, t) {
    const parts = [];
    const refs = (item?.meta?.frameworks || [])
        .map(f => formatArticleRef(f?.regulation, f?.ref, t))
        .filter(Boolean);
    if (refs.length) {
        const more = refs.length - MAX_REFS;
        parts.push(refs.slice(0, MAX_REFS).join(' · ') + (more > 0 ? ` · ${t('compliance.ref_more', '+{n}', { n: more })}` : ''));
    }
    const sev = item?.meta?.severity || item?.severity;
    if (sev) parts.push(t(`compliance.sev_${sev}`, sev));
    // A register item says 'register' — not a verification kind, so nothing to print.
    const ver = item?.meta?.verification;
    if (VERIFICATION_KINDS.includes(ver)) parts.push(t(`compliance.verification_${ver}`, ver));
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

export default function MobileHomeOverview({ data, navigate, onTab = undefined }) {
    const { t } = useTranslation();
    const [attentionExpanded, setAttentionExpanded] = useState(false);
    const attentionListId = useId();
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
    const attentionItems = Array.isArray(attention.items) ? attention.items : null;
    const canExpand = !!attentionItems && attentionItems.length > ATTENTION_FOLDED;
    const shownAttention = attentionItems && canExpand && !attentionExpanded ? attentionItems.slice(0, ATTENTION_FOLDED) : attentionItems;
    const attentionTotal = attention.attention?.total;
    const elsewhere = attentionItems && typeof attentionTotal === 'number' ? Math.max(0, attentionTotal - attentionItems.length) : 0;
    const calendar = data?.calendar || {};

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
                                    {isNum(open) && open > 0 ? ` · ${t('compliance.mob_fw_open', '{n} open', { n: open })}` : ''}
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
                {attentionItems === null ? (
                    attention.failed
                        ? <Note tone="error" testId="mobile-attention-failed">{t('compliance.mob_attention_failed', 'Could not load the open items.')}</Note>
                        : <Note testId="mobile-attention-loading">{t('compliance.mob_loading', 'Loading…')}</Note>
                ) : attentionItems.length === 0 ? (
                    <Note testId="mobile-attention-empty">{t('compliance.mob_attention_empty', 'Nothing needs attention right now.')}</Note>
                ) : <div id={attentionListId}>{shownAttention.map((item) => {
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
                })}</div>}
                {attentionItems && elsewhere > 0 && (attentionExpanded || !canExpand) ? (
                    <Note testId="mobile-attention-elsewhere">{t('compliance.ovw_more_elsewhere', '{n} more on the framework pages', { n: elsewhere })}</Note>
                ) : null}
                {canExpand ? (
                    <button type="button" data-testid="mobile-attention-toggle" onClick={() => setAttentionExpanded(v => !v)}
                        aria-expanded={attentionExpanded} aria-controls={attentionListId}
                        className={`${MOBILE_ROW_CLASS} border-t border-[var(--border-default)] text-[13px] font-medium text-[var(--text-secondary)]`}>
                        <span className="flex-1">
                            {attentionExpanded
                                ? t('compliance.ovw_show_fewer', 'Show fewer')
                                : t('compliance.ovw_show_all', 'Show all {n}', { n: attentionItems.length })}
                        </span>
                        <ChevronDown size={16} aria-hidden="true" className={`flex-shrink-0 text-[var(--text-tertiary)] transition-transform ${attentionExpanded ? 'rotate-180' : ''}`} />
                    </button>
                ) : null}
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
                    // The article as the server wrote it ("GDPR Art. 12(3)") and, for an
                    // obligation or attestation, the subject kind instead of a ref.
                    const meta = [kindLabel, d.meta?.article || null, deadlineSubjectKind(d)].filter(Boolean).join(' · ');
                    const title = [deadlineRef(d), d.title].filter(Boolean).join(' · ');
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

            {/* ── Upcoming dates, then the Overview's other two tabs ── */}
            <UpcomingDatesCard milestones={calendar.milestones ?? null} failed={!!calendar.failed}
                onOpenCalendar={onTab ? () => onTab('calendar') : undefined} testId="mobile-upcoming-dates" />
            <MobileCard testId="mobile-overview-entries">
                <EntryRow icon={CalendarDays} label={t('compliance.mob_calendar_entry', 'Regulatory calendar')}
                    onClick={() => onTab?.('calendar')} testId="mobile-entry-calendar" />
                <EntryRow icon={FileDown} label={t('compliance.mob_reports_entry', 'Reports and downloads')}
                    onClick={() => onTab?.('reports')} testId="mobile-entry-reports" />
            </MobileCard>
        </div>
    );
}

function EntryRow({ icon, label, onClick, testId }) {
    const Icon = icon;
    return (
        <button type="button" data-testid={testId} onClick={onClick}
            className={`${MOBILE_ROW_CLASS} border-b border-[var(--border-default)] last:border-b-0`}>
            <Icon size={16} aria-hidden="true" className="flex-shrink-0 text-[var(--text-secondary)]" />
            <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-[var(--text-primary)]">{label}</span>
            <ChevronRight size={16} aria-hidden="true" className="flex-shrink-0 text-[var(--text-tertiary)]" />
        </button>
    );
}
