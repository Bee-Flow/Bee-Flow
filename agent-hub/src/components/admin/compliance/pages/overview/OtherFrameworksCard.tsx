// OtherFrameworksCard — the frameworks an org switched on beyond the three
// core ones (DORA, NIS2, the CRA, …), one 40px row each, under the score
// cards on the Overview. The page meant to summarise everything used to
// leave them out: a DORA score of 75 lived only in the rail.
//
// The rows are the rail's own rule: an optional framework section that is
// visible for this org (ComplianceRail.visibleSections) and scores a
// regulation. The score is the one the Overview scores everything with
// (`frameworks_detail`, else the counts); the open count is openChecksFor,
// the same number the rail's "Needs attention" filter uses.

import { ChevronRight } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { HEADLINE_FALLBACK, TONES, headlineKeyOfScore, toneOfScore } from '../../../../shared/statusTone';
import { visibleSections } from '../../ComplianceRail';
import { openChecksFor, type CheckLike } from '../../data/openChecks';
import { railScore } from '../../railMeta';
import { sectionsInGroup } from '../../sections';
import ScoreRingJs from '../../shared/ScoreRing';

interface SectionLike {
    id: string;
    regulation?: string | null;
    optional?: boolean;
    icon?: React.ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;
    labelKey: string;
    labelFallback: string;
}

type Tone = keyof typeof TONES;

export interface OtherFrameworkRow {
    id: string;
    label: string;
    score: number | undefined;
    tone: Tone;
    headlineKey: string;
    open: number | undefined;
}

type Translate = (key: string, fallback?: string, vars?: Record<string, unknown>) => string;

interface Overview {
    frameworks_detail?: Record<string, { score?: number | null } | null | undefined> | null;
}

interface FrameworksHook {
    isEnabled?: (id: string) => boolean;
}

// ScoreRing is plain JavaScript; these are the props it takes.
const ScoreRing = ScoreRingJs as unknown as React.ComponentType<{
    score?: number; size?: number; tone?: Tone; label?: string; testId?: string;
}>;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The rows: enabled optional frameworks that score a regulation, in rail order. */
export function otherFrameworkRows({ counts, frameworks, overview, checks, t }: {
    counts: unknown;
    frameworks: FrameworksHook | null | undefined;
    overview: Overview | null | undefined;
    checks: ReadonlyArray<CheckLike | null> | null | undefined;
    t: Translate;
}): OtherFrameworkRow[] {
    const all = sectionsInGroup('frameworks') as unknown as SectionLike[];
    const visible = visibleSections(all, { counts, frameworks }) as SectionLike[];
    return visible
        .filter((s) => s.optional && s.regulation)
        .map((s) => {
            const detail = overview?.frameworks_detail?.[s.id]?.score;
            const score = isNum(detail) ? detail : railScore(counts, s.id);
            const tone = toneOfScore(score) as Tone;
            return {
                id: s.id,
                label: t(s.labelKey, s.labelFallback),
                score: isNum(score) ? score : undefined,
                tone,
                headlineKey: headlineKeyOfScore(score),
                open: openChecksFor(checks, s.regulation),
            };
        });
}

export default function OtherFrameworksCard({
    counts, frameworks, overview, checks, navigate, testId = 'other-frameworks',
}: {
    counts: unknown;
    frameworks?: FrameworksHook | null;
    overview?: Overview | null;
    checks?: ReadonlyArray<CheckLike | null> | null;
    navigate?: (sectionId: string, subId?: string, tab?: string) => void;
    testId?: string;
}) {
    const { t } = useTranslation();
    const rows = otherFrameworkRows({ counts, frameworks, overview, checks, t });
    if (rows.length === 0) return null;
    const title = t('compliance.ovw_other_frameworks', 'Other frameworks');
    return (
        <section
            className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-2.5 shadow-[var(--shadow-sm)]"
            data-testid={testId}
            aria-label={title}
        >
            <h3 className="m-0 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-tertiary)]">{title}</h3>
            <ul className="m-0 mt-1 grid list-none grid-cols-3 gap-x-4 p-0 @max-[880px]/cpage:grid-cols-2 @max-[600px]/cpage:grid-cols-1">
                {rows.map((row) => {
                    const headline = t(row.headlineKey, HEADLINE_FALLBACK[row.headlineKey as keyof typeof HEADLINE_FALLBACK]);
                    return (
                        <li key={row.id}>
                            <button
                                type="button"
                                onClick={() => navigate?.(row.id)}
                                className="group flex h-10 w-full min-w-0 items-center gap-2.5 rounded-md px-1 text-left hover:bg-[var(--bg-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                                data-testid={`${testId}-row-${row.id}`}
                                data-tone={row.tone}
                            >
                                <ScoreRing score={row.score} size={28} tone={row.tone} label={row.label} testId={`${testId}-ring-${row.id}`} />
                                {/* The name and the open count never truncate; the headline gives way. */}
                                <span className="flex min-w-0 flex-1 items-baseline whitespace-nowrap text-[12px]">
                                    <span className="shrink-0 font-semibold text-[var(--text-primary)]">{row.label}</span>
                                    <span className="shrink-0 text-[var(--text-tertiary)]">{'\u00a0·\u00a0'}</span>
                                    <span className={`min-w-0 truncate font-medium ${INK_CLASS[row.tone]}`} title={headline} data-testid={`${testId}-headline-${row.id}`}>{headline}</span>
                                    {isNum(row.open) && row.open > 0 ? (
                                        <span className="shrink-0 text-[var(--text-tertiary)]" data-testid={`${testId}-open-${row.id}`}>
                                            {'\u00a0·\u00a0'}{t('compliance.rail_meta_open', '{n} open', { n: row.open })}
                                        </span>
                                    ) : null}
                                </span>
                                <ChevronRight size={14} aria-hidden className="shrink-0 text-[var(--text-tertiary)] group-hover:text-[var(--text-primary)]" />
                            </button>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

/** The tone's ink as a Tailwind class on the theme variable (no style objects). */
const INK_CLASS: Record<Tone, string> = {
    success: 'text-[var(--success-ink)]',
    warning: 'text-[var(--warning-ink)]',
    error: 'text-[var(--error-ink)]',
    neutral: 'text-[var(--text-tertiary)]',
};
