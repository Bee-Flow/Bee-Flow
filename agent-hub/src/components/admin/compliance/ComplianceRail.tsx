/**
 * ComplianceRail — the 300 px rail of the Compliance Center
 * ('Compliance Rail.dc.html', redesign Sep 2026).
 *
 * No head of its own: the admin dashboard's page frame already names the page
 * ("Compliance") and the section header names the section, so a third title
 * here only repeated them. Body: search + the reports download · "All | Needs
 * attention N" · grouped rows (KADERS · REGISTERS · BEHEER) with a right-hand
 * meta from railMeta.js — an actionable count or nothing; a row's background
 * figures (railHint) are its tooltip and its accessible description. Foot: the
 * evidence-chain line. The hub puts it in a fixed-height column, so THIS
 * component is an `h-full flex flex-col` whose list is the only scrolling part,
 * or the footer scrolls away (the MeetingNotesPage rail has the same constraint).
 *
 * Row recipe = the admin dashboard rail (AdminRail): rounded-lg, px-2.5,
 * 13px, a secondary-ink icon; active is a raised card (`bg-card` + `shadow-sm`),
 * never an accent bar; hover is `--item-hover-bg`. Every row carries `title`
 * (the label, plus the hint on a second line when there is one),
 * `aria-current` and `data-testid="rail-row-<id>"`.
 *
 * "Needs attention" keeps a framework row while it has an open (fail/warn)
 * check — the same count the row then shows as "{n} to fix" — and falls back
 * to the score only while the checks have not loaded (`checks` null).
 *
 * The search also lists checks (from two characters): by title, by article
 * as written ("Art. 50", "AI Act Art. 50", "A.5.20") and by id, one hit per
 * check with "· n" when it runs per subject; a hit opens the framework page
 * that scores it, focused on that row.
 *
 * Growing-set frameworks (`section.optional`) appear only once the org has
 * enabled them (counts.frameworks[id] present or frameworks.isEnabled(id));
 * the CRA/Data Act registers follow their framework.
 */
import { Download, Search, ShieldCheck, Timer } from 'lucide-react';
import React, { useId, useMemo, useState } from 'react';
import { searchChecks, type SearchableCheck } from './data/checkSearch';
import { openChecksFor, type CheckLike } from './data/openChecks';
import { countFor } from './data/useComplianceCounts';
import railMeta, { railHint, railRowTitle } from './railMeta';
import { GROUPS, SECTIONS, frameworkOf, sectionForRegulation, type Section } from './sections';
import ArticleRef from './shared/ArticleRef';
import { useTranslation, type TranslateParams } from '@/hooks/useTranslation';
import DeadlineClock from '../../shared/DeadlineClock';
import SegmentedControl from '../../shared/SegmentedControl';
import { toneDotClass, toneInkClass } from './shared/toneClasses';
import type { TimeInput } from '../../shared/deadlineMath';
import type { CheckRecord } from './pages/framework/checkSort';

/** A rail row's right-hand meta, from railMeta. */
interface RailMeta {
    kind: string;
    text?: React.ReactNode;
    score?: number;
    tone?: string | null;
    badge?: string | null;
    dueAt?: TimeInput;
    startedAt?: TimeInput;
    urgentBelowMs?: number | null;
    suffix?: React.ReactNode;
}

const REGISTER_FRAMEWORK: Readonly<Record<string, string>> = Object.freeze({ vulnerabilities: 'cra', portability: 'data_act' });

function frameworkIdOfSection(id: string) {
    return id === 'iso' ? 'iso27001' : id;
}

/** Which optional rows are visible for this org. */
export function visibleSections(sections: readonly Section[], { counts, frameworks }: { counts: unknown; frameworks?: { isEnabled?: (id: string) => boolean } | null }) {
    return sections.filter((s) => {
        if (!s.optional) return true;
        const fwId = REGISTER_FRAMEWORK[s.id] || frameworkIdOfSection(s.id);
        if (counts && countFor(counts, `frameworks.${fwId}`) !== undefined) return true;
        return !!frameworks?.isEnabled?.(fwId);
    });
}

/** Days after which the ROPA review is due (railMeta shows "review due"). */
const ROPA_REVIEW_DAYS = 365;

/**
 * Rows that have something open — the "Needs attention" filter. A framework
 * row qualifies with an open check (`checks` loaded), else — only while the
 * checks are still null — with a score under 85.
 */
export function hasOpenItem(section: Section, counts: unknown, checks: readonly (CheckLike | null)[] | null = null) {
    const regulation = section.regulation ?? frameworkOf(section.id);
    if (regulation) {
        const open = openChecksFor(checks, regulation);
        if (open !== undefined) return open > 0;
        const s = countFor(counts, `frameworks.${frameworkIdOfSection(section.id)}.score`);
        return typeof s === 'number' && s < 85;
    }
    switch (section.id) {
        case 'ropa': {
            const ropa = countFor(counts, 'ropa');
            if (!ropa || typeof ropa !== 'object') return false;
            const at = ropa.last_reviewed_at ? new Date(ropa.last_reviewed_at).getTime() : NaN;
            return !Number.isFinite(at) || Date.now() - at > ROPA_REVIEW_DAYS * 86_400_000;
        }
        case 'dsr': return (countFor(counts, 'dsr.overdue') || 0) > 0 || (countFor(counts, 'dsr.due_soon') || 0) > 0;
        case 'incidents': return (countFor(counts, 'incidents.open') || 0) > 0;
        case 'vulnerabilities': return (countFor(counts, 'incidents.vulnerabilities_open') || 0) > 0;
        case 'dpia': return (countFor(counts, 'dpia.todo') || 0) > 0;
        case 'risks': return (countFor(counts, 'risks.high') || 0) > 0;
        case 'soa': {
            const todo = countFor(counts, 'soa.todo');
            if (typeof todo === 'number') return todo > 0;
            const a = countFor(counts, 'soa.approved'); const t = countFor(counts, 'soa.total');
            return typeof a === 'number' && typeof t === 'number' && a < t;
        }
        case 'policies': return (countFor(counts, 'policies.review_due') || 0) > 0;
        case 'training': { const d = countFor(counts, 'training.done'); const t = countFor(counts, 'training.total'); return typeof d === 'number' && typeof t === 'number' && d < t; }
        default: return false;
    }
}

interface MetaProps {
    meta: RailMeta | null;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

function Meta({ meta, t }: MetaProps) {
    if (!meta) return null;
    if (meta.kind === 'text') {
        return <span className="ml-auto flex-shrink-0 text-[11px] tabular-nums text-[var(--text-tertiary)]" data-testid="rail-meta">{meta.text}</span>;
    }
    if (meta.kind === 'score') {
        return (
            <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-semibold tabular-nums text-[var(--text-primary)]" data-testid="rail-meta">
                <span className={`inline-block w-2 h-2 rounded-full ${toneDotClass(meta.tone)}`} aria-hidden="true" />
                {meta.score}
            </span>
        );
    }
    if (meta.kind === 'clock') {
        return (
            <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] tabular-nums text-[var(--text-tertiary)]" data-testid="rail-meta">
                {meta.badge && (
                    <span className={`inline-flex items-center gap-[3px] font-semibold ${toneInkClass(meta.tone)}`}>
                        <Timer className="w-[11px] h-[11px]" aria-hidden="true" />{meta.badge}
                    </span>
                )}
                {!meta.badge && meta.dueAt && (
                    <DeadlineClock variant="rail" dueAt={meta.dueAt} startedAt={meta.startedAt} urgentBelowMs={meta.urgentBelowMs} testId="rail-meta-clock" />
                )}
                <span>{meta.suffix}</span>
            </span>
        );
    }
    return null;
}

/** One rail row, as the admin dashboard rail draws it (the active and hover surfaces are added per row). */
const ROW_CLASS = 'w-full flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-tight transition-colors duration-150';

interface RailRowProps {
    section: Section;
    label: string;
    active: boolean;
    meta: RailMeta | null;
    hint: string | null;
    onClick: React.MouseEventHandler<HTMLButtonElement>;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

function RailRow({ section, label, active, meta, hint, onClick, t }: RailRowProps) {
    const Icon = section.icon;
    const hintId = `${useId()}-hint`;
    return (
        <>
            <button
                type="button"
                title={railRowTitle(label, hint)}
                aria-current={active ? 'page' : undefined}
                aria-describedby={hint ? hintId : undefined}
                onClick={onClick}
                data-testid={`rail-row-${section.id}`}
                className={`${ROW_CLASS} ${active ? 'bg-[var(--bg-card)] shadow-sm' : 'hover:bg-[var(--item-hover-bg)]'}`}
            >
                {Icon && <Icon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />}
                <span className={`min-w-0 truncate text-[var(--text-primary)] ${active ? 'font-semibold' : 'font-medium'}`}>{label}</span>
                <Meta meta={meta} t={t} />
            </button>
            {/* Outside the button, so the row's name stays its label + meta. */}
            {hint && <span id={hintId} className="sr-only" data-testid={`rail-hint-${section.id}`}>{hint}</span>}
        </>
    );
}

interface GroupLabelProps {
    children?: React.ReactNode;
}

function GroupLabel({ children }: GroupLabelProps) {
    return (
        <div className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]">{children}</div>
    );
}

interface ComplianceRailProps {
    active: string;
    onSelect: (id: string, sub?: string | null) => void;
    onOpenReports: () => void;
    counts?: unknown;
    frameworks?: { isEnabled?: (id: string) => boolean } | null;
    checks?: readonly CheckRecord[] | null;
    locale?: string;
    exportsEnabled?: boolean;
    testId?: string;
}

export default function ComplianceRail({
    active, onSelect, onOpenReports, counts = null, frameworks = null, checks = [], exportsEnabled = true,
    locale = undefined, testId = 'compliance-rail',
}: ComplianceRailProps) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [mode, setMode] = useState('all');
    const attention = countFor(counts, 'attention_open');
    const q = query.trim().toLowerCase();

    const rows = useMemo(() => {
        const visible = visibleSections(SECTIONS, { counts, frameworks });
        return visible.filter((s) => {
            if (mode === 'attention' && s.id !== 'overview' && !hasOpenItem(s, counts, checks)) return false;
            if (!q) return true;
            const label = t(s.labelKey, s.labelFallback).toLowerCase();
            return label.includes(q) || s.id.includes(q);
        });
    }, [counts, frameworks, mode, q, t, checks]);

    // ≥ 2 characters also search the checks → the framework page, focused on the row.
    const checkHits = useMemo(() => searchChecks(checks as readonly SearchableCheck[] | null, q, t), [checks, q, t]);
    // In the attention view a framework row says how many of its checks are open.
    const metaOf = (s: Section) => railMeta(s, counts, t, {
        failing: mode === 'attention' && s.regulation ? openChecksFor(checks, s.regulation) : undefined,
    });

    const overview = rows.find(s => s.id === 'overview');
    const evidenceRows = countFor(counts, 'evidence.rows');
    const chainOk = countFor(counts, 'evidence.chain_ok');
    const algo = countFor(counts, 'evidence.algorithm') || 'SHA-256';

    return (
        <div className="h-full flex flex-col min-h-0 text-[13px] text-[var(--text-primary)]" data-testid={testId}>
            {/* Body */}
            <div className="p-2.5 flex flex-col gap-2 flex-1 min-h-0">
                <div className="flex flex-shrink-0 items-center gap-1.5">
                    <label className="relative block min-w-0 flex-1">
                        <Search className="w-[13px] h-[13px] absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden="true" />
                        <input value={query} onChange={(e) => setQuery(e.target.value)}
                            placeholder={t('compliance.rail_search_placeholder', 'Search checks, articles or registers…')}
                            aria-label={t('compliance.rail_search_placeholder', 'Search checks, articles or registers…')}
                            className="w-full pl-8 pr-2 py-1.5 rounded-lg text-xs text-ellipsis border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--accent-primary)]"
                            data-testid={`${testId}-search`} />
                    </label>
                    {exportsEnabled && onOpenReports && (
                        <button type="button" onClick={onOpenReports} aria-label={t('compliance.rail_reports_aria', 'Reports and downloads')}
                            title={t('compliance.rail_reports_aria', 'Reports and downloads')}
                            className="w-8 h-8 flex-shrink-0 rounded-lg grid place-items-center text-[var(--text-secondary)] border border-[var(--border-default)] bg-[var(--bg-card)] hover:bg-[var(--item-hover-bg)]"
                            data-testid={`${testId}-download`}>
                            <Download className="w-[13px] h-[13px]" aria-hidden="true" />
                        </button>
                    )}
                </div>
                <SegmentedControl size="sm" fullWidth ariaLabel={t('compliance.rail_filter_aria', 'Show all or only what needs attention')}
                    value={mode} onChange={setMode}
                    options={[
                        { value: 'all', label: t('compliance.seg_all', 'All') },
                        { value: 'attention', label: t('compliance.seg_attention', 'Needs attention'), badge: { count: typeof attention === 'number' ? attention : null, tone: 'warning' } },
                    ]} />

                <div className="flex-1 min-h-0 overflow-y-auto -mx-0.5 px-0.5 flex flex-col gap-0.5 mt-0.5" data-testid={`${testId}-list`}>
                    {overview && (
                        <RailRow section={overview} label={t(overview.labelKey, overview.labelFallback)} active={active === 'overview'}
                            meta={metaOf(overview)} hint={railHint(overview, counts, t, { locale })} onClick={() => onSelect('overview')} t={t} />
                    )}
                    {checkHits.length > 0 && (
                        <>
                            <GroupLabel>{t('compliance.rail_group_checks', 'Checks')}</GroupLabel>
                            {checkHits.map(({ check: c, title, scopes }) => (
                                <button key={c.check_id} type="button" title={title}
                                    onClick={() => onSelect(sectionForRegulation(c.regulation as string), c.check_id)}
                                    className={`${ROW_CLASS} text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]`}
                                    data-testid={`${testId}-check-hit`} data-check={c.check_id}>
                                    <span className="truncate">{title}</span>
                                    {scopes > 1 && (
                                        <span className="flex-shrink-0 text-[11px] tabular-nums text-[var(--text-tertiary)]"
                                            title={t('compliance.attention_subjects', '{n} affected', { n: scopes })} data-testid={`${testId}-check-scopes`}>
                                            · {scopes}
                                        </span>
                                    )}
                                    <ArticleRef refs={[{ regulation: c.regulation, ref: c.article }]} className="ml-auto flex-shrink-0" testId={`${testId}-check-ref`} />
                                </button>
                            ))}
                        </>
                    )}
                    {GROUPS.map((g) => {
                        const inGroup = rows.filter(s => s.group === g.id);
                        if (!inGroup.length) return null;
                        return (
                            <React.Fragment key={g.id}>
                                <GroupLabel>{t(g.labelKey, g.labelFallback)}</GroupLabel>
                                {inGroup.map((s) => (
                                    <RailRow key={s.id} section={s} label={t(s.labelKey, s.labelFallback)} active={active === s.id}
                                        meta={metaOf(s)} hint={railHint(s, counts, t, { locale })} onClick={() => onSelect(s.id)} t={t} />
                                ))}
                            </React.Fragment>
                        );
                    })}
                    {rows.length <= 1 && !checkHits.length && q && (
                        <div className="px-2.5 py-3 text-[13px] text-[var(--text-tertiary)]">{t('compliance.rail_search_empty', 'Nothing matches')}</div>
                    )}
                </div>
            </div>

            {/* Foot — evidence chain */}
            {chainOk !== undefined && (
                <div className="flex-shrink-0 px-3.5 py-2.5 border-t border-[var(--border-default)] flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]"
                    data-testid={`${testId}-chain`}>
                    <ShieldCheck className={`w-3 h-3 flex-shrink-0 ${chainOk ? 'text-[var(--success-ink)]' : 'text-[var(--error-ink)]'}`} aria-hidden="true" />
                    {chainOk
                        ? t('compliance.rail_chain_intact', 'Evidence chain intact · {rows} rows · {algo}', { rows: typeof evidenceRows === 'number' ? evidenceRows.toLocaleString() : '—', algo })
                        : <span className="text-[var(--error-ink)]">{t('compliance.rail_chain_broken', 'Evidence chain broken — check the integrity report')}</span>}
                </div>
            )}
        </div>
    );
}

;
