import { AlertTriangle, ArrowUpCircle, CheckCircle2, HelpCircle, Info } from 'lucide-react';
import React from 'react';
import { STAGE_DOT } from './pipeline/StageSwitcher';
import { stripOf } from './pipeline/stagesApi';
import { countPhrase } from './solutionCounts';
import { sectionNames } from './solutionNotices';
import { chipsOf, runsOf } from './solutionOverviewModel';
import { useTranslation } from '../../../../hooks/useTranslation';
import { kindColorVar, kindIcon } from '../../../shared/kindColors';
import { nOf } from '../KnowledgeStudio/plural';

/**
 * The pieces of one Solution card (SolutionCard.jsx composes them).
 *
 * THE CARD MAY NOT INVENT GOOD NEWS. A tally the server could not read arrives
 * as `null` and never paints as a 0, a missing chip or a green tick; each
 * "we do not know" state keeps a visible treatment of its own (see
 * solutionOverviewModel.js for the decisions, this file only renders them).
 * Colour follows index.css: words take the `-ink` token, tint and border the
 * raw one (written out as literal classes so Tailwind can see them).
 */

type Row = Record<string, any>;
type Translate = (key: string, fallback?: string, vars?: Record<string, unknown>) => string;

interface HealthLike { state: string; count?: number }

const CHIP = 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium flex-shrink-0';

const HEALTH_TONE: Record<string, { icon: typeof Info; cls: string }> = {
    unknown: { icon: HelpCircle, cls: 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]' },
    unread: { icon: AlertTriangle, cls: 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error-ink)]' },
    blocking: { icon: AlertTriangle, cls: 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error-ink)]' },
    advice: { icon: Info, cls: 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning-ink)]' },
    clear: { icon: CheckCircle2, cls: 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]' },
};

/**
 * The two counted states go through `nOf` with their key written out so the
 * `_plural` half exists as a literal the i18n guard can see. The unknown states
 * carry a `title`: "Not checked" without "so this is not a clean bill of
 * health" is exactly the reading this screen must not invite.
 */
function healthWords(t: Translate, health: HealthLike): { label: string; title?: string } {
    switch (health.state) {
        case 'blocking':
            return { label: nOf(t, 'solutions.card_health_blocking', health.count, '{count} thing to fix', '{count} things to fix') };
        case 'advice':
            return { label: nOf(t, 'solutions.card_health_advice', health.count, '{count} thing to look at', '{count} things to look at') };
        case 'unread':
            return {
                label: t('solutions.card_health_unread', 'Could not be fully read'),
                title: t('solutions.card_health_unread_hint',
                    'Part of this Solution could not be read, so how much needs fixing is not known.'),
            };
        case 'clear':
            return { label: t('solutions.card_health_clear', 'Complete') };
        default:
            return {
                label: t('solutions.card_health_unknown', 'Not checked'),
                title: t('solutions.card_health_unknown_hint',
                    'The checks did not run for this Solution, so this is not a clean bill of health.'),
            };
    }
}

export function HealthChip({ health }: { health: HealthLike }) {
    const { t } = useTranslation();
    const tone = HEALTH_TONE[health.state] || HEALTH_TONE.unknown;
    const Icon = tone.icon;
    const { label, title } = healthWords(t, health);
    return (
        <span className={`${CHIP} ${tone.cls}`} data-testid="solution-card-health" data-state={health.state} title={title}>
            <Icon className="w-3 h-3" aria-hidden="true" />
            {label}
        </span>
    );
}

/**
 * "v1.5 available", and the honest silence around it: a chip for `available`
 * and for `unknown` (so a missing chip means exactly "up to date" or "not from
 * a Blueprint"), nothing for `current`.
 */
export function UpdateChip({ update }: { update: { state: string; latestVersion: number | null } | null }) {
    const { t } = useTranslation();
    if (!update || update.state === 'current') return null;
    if (update.state === 'available') {
        return (
            <span className={`${CHIP} bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning-ink)]`}
                  data-testid="solution-card-update" data-state="available">
                <ArrowUpCircle className="w-3 h-3" aria-hidden="true" />
                {update.latestVersion === null
                    ? t('solutions.card_update_any', 'A newer version is available')
                    : t('solutions.card_update_available', 'v{version} available', { version: update.latestVersion })}
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]"
              data-testid="solution-card-update" data-state="unknown">
            <HelpCircle className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
            {t('solutions.card_update_unknown', 'Whether there is a newer version could not be checked')}
        </span>
    );
}

/** Icon + number per kind, and the kinds whose number could not be read. */
export function CountChips({ row }: { row: Row }) {
    const { t } = useTranslation();
    const { chips, unreadable } = chipsOf(row) as { chips: { section: string; kind: string; count: number }[]; unreadable: string[] };
    if (chips.length === 0 && unreadable.length === 0) return null;
    return (
        <span className="flex flex-wrap items-center gap-1.5">
            {chips.map(({ section, kind, count }) => {
                const Icon = kindIcon(kind);
                const phrase = countPhrase(t, section, count);
                return (
                    <span
                        key={section}
                        data-testid="solution-card-chip"
                        data-section={section}
                        title={phrase}
                        aria-label={phrase}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium tabular-nums bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                    >
                        {Icon && <Icon className="w-3 h-3" style={{ color: kindColorVar(kind) }} aria-hidden="true" />}
                        {count}
                    </span>
                );
            })}
            {/* A count that could not be read is NOT a missing chip. */}
            {unreadable.length > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-tertiary)]"
                      data-testid="solution-card-counts-partial">
                    <AlertTriangle className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                    {t('solutions.card_counts_partial', 'Not everything could be counted: {sections}',
                        { sections: sectionNames(unreadable, t).join(', ') })}
                </span>
            )}
        </span>
    );
}

/** How often this Solution ran today, including "nobody could tell". */
export function RunLine({ row }: { row: Row }) {
    const { t } = useTranslation();
    const runs = runsOf(row) as { state: string; today: number; failed: number };
    if (runs.state === 'unknown') {
        return (
            <span className="inline-flex items-center gap-1.5 text-[var(--text-tertiary)]" data-testid="solution-card-runs" data-state="unknown">
                <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                {t('solutions.card_runs_unknown', 'Runs could not be counted')}
            </span>
        );
    }
    if (runs.state === 'idle') {
        return (
            <span className="text-[var(--text-tertiary)]" data-testid="solution-card-runs" data-state="idle">
                {t('solutions.card_runs_idle', 'Nothing ran today')}
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1.5" data-testid="solution-card-runs" data-state={runs.state}>
            <span className="text-[var(--text-tertiary)] tabular-nums">
                {nOf(t, 'solutions.card_runs_today', runs.today, '{count} run today', '{count} runs today')}
            </span>
            {runs.state === 'failed' && (
                <span className="inline-flex items-center gap-1 text-[var(--error-ink)]">
                    <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                    {/* Identical English forms on purpose; the PAIR must still exist for languages that inflect. */}
                    {nOf(t, 'solutions.card_runs_failed', runs.failed, '{count} failed', '{count} failed')}
                </span>
            )}
        </span>
    );
}

const DOT_TONE: Record<string, string> = {
    ok: 'bg-[var(--success)]',
    warning: 'bg-[var(--warning)]',
    error: 'bg-[var(--error)]',
    busy: 'bg-[var(--accent-primary)] animate-pulse motion-reduce:animate-none',
    none: 'bg-[var(--text-tertiary)] opacity-60',
};

const TONE_WORD: Record<string, [string, string]> = {
    ok: ['solution_stages.strip_ok', 'running'],
    warning: ['solution_stages.strip_warning', 'needs attention'],
    error: ['solution_stages.strip_error', 'last deployment failed'],
    busy: ['solution_stages.strip_busy', 'deploying'],
    none: ['solution_stages.strip_none', 'nothing deployed'],
};

/**
 * `Dev -> UAT R7 -> PRD R6`: each stage as a dot in its stage colour, a label
 * and the release it runs, with a small status dot for how its last deployment
 * went (read from /summary, no fetch per card). The stage colour is an accent
 * only; the status dot and the sr-only words carry the state. A Solution
 * without stages gets no track at all.
 */
export function StageTrack({ stages }: { stages: unknown }) {
    const { t } = useTranslation();
    const strip = stripOf(stages);
    if (strip.length === 0) return null;
    const names: Record<string, string> = {
        uat: t('solution_stages.strip_uat', 'UAT'),
        prd: t('solution_stages.strip_prd', 'PRD'),
    };
    return (
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] font-medium text-[var(--text-secondary)]" data-testid="solution-card-stages">
            <span className="inline-flex items-center gap-1">
                <span className={`inline-block w-2 h-2 rounded-full ${STAGE_DOT.dev}`} aria-hidden="true" />
                {t('solution_stages.strip_dev', 'Dev')}
            </span>
            {strip.map(s => (
                <span key={s.stage} className="inline-flex items-center gap-1.5" data-testid="solution-card-stage" data-stage={s.stage} data-tone={s.tone}>
                    <span aria-hidden="true" className="text-[var(--text-tertiary)]">{'\u2192'}</span>
                    <span className="inline-flex items-center gap-1">
                        <span className={`inline-block w-2 h-2 rounded-full ${STAGE_DOT[s.stage]}`} aria-hidden="true" />
                        <span className="tabular-nums">{names[s.stage]}{s.seq !== null && ` R${s.seq}`}</span>
                    </span>
                    <span className={`inline-block w-1.5 h-1.5 rounded-full ring-2 ring-[var(--bg-card)] ${DOT_TONE[s.tone]}`} aria-hidden="true" />
                    <span className="sr-only">{t(TONE_WORD[s.tone][0], TONE_WORD[s.tone][1])}</span>
                </span>
            ))}
        </span>
    );
}

const ROLE_LABEL: Record<string, [string, string]> = {
    owner: ['solutions.card_role_owner', 'owner'],
    editor: ['solutions.card_role_editor', 'editor'],
    viewer: ['solutions.card_role_viewer', 'viewer'],
};

/** Role, and where this Solution came from. */
export function SubLine({ row, update }: { row: Row; update: { installedVersion: number | null } | null }) {
    const { t } = useTranslation();
    const role = ROLE_LABEL[row.permission] || ROLE_LABEL.viewer;
    const parts = [t(role[0], role[1])];
    if (row.installedFromBlueprintId) {
        parts.push(update && update.installedVersion !== null
            ? t('solutions.card_installed_at', 'installed at v{version}', { version: update.installedVersion })
            : t('solutions.card_installed_from', 'installed from a Blueprint'));
    }
    return (
        <span className="block text-[11px] truncate text-[var(--text-tertiary)]" data-testid="solution-card-sub">
            {parts.join(' \u00b7 ')}
        </span>
    );
}
