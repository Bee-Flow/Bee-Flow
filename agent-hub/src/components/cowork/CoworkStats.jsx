/**
 * The figures under the assignment card (CW-11): how often this work has run,
 * how much of that went well, and how long a run takes.
 *
 * Three cards, not the four the artboard draws. The fourth is "Kosten deze
 * maand € 3,18 · 1,4 mln tokens", and the run path records no tokens and no
 * cost at all (CW-12): every euro that card could show would be invented. A
 * missing card is a gap; a fabricated amount on a page about someone's money
 * is a lie, and the one thing worse than three cards is four cards of which
 * one is quietly wrong. The card comes back with CW-12, from a real column.
 *
 * Two numbers that look interchangeable and are not:
 *
 *   - `runCount` is the schedule's OWN lifetime tally, and it is what the
 *     first card shows. It survives the 90-day retention sweep.
 *   - `total` / `success` / `failed` count the run rows that still exist. So
 *     "42 runs" beside "38 succeeded" is not a contradiction on an old item:
 *     the four missing ones were swept, not lost. The success card therefore
 *     talks about what went WRONG in the kept history rather than printing a
 *     ratio out of a total it does not share.
 *
 * Fetched here rather than by the parent so a failure costs the figures and
 * nothing else: the brief, the buttons and the history all still render.
 */
import React, { useEffect, useState } from 'react';
import * as coworkApi from './coworkApi';
import { formatDuration } from './coworkFormat';
import { useTranslation } from '../../hooks/useTranslation';

/** One card: a small label, a big tabular number, a quiet line under it. */
function Figure({ label, value, sub, tone }) {
    return (
        <div
            className="flex-1 min-w-0 rounded-[10px] border px-4 py-3.5 flex flex-col gap-1"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', boxShadow: 'var(--shadow-sm)' }}
        >
            <div
                className="text-[10.5px] font-semibold uppercase tracking-wide truncate"
                style={{ color: 'var(--text-tertiary)' }}
            >
                {label}
            </div>
            <div
                className="text-[20px] font-semibold tabular-nums truncate"
                style={{ color: tone || 'var(--text-primary)' }}
            >
                {value}
            </div>
            <div className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>{sub}</div>
        </div>
    );
}

/** "8 July" — the month in words, because "8/7" means two different days. */
function monthDay(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
}

/**
 * "2 runs failed" / "1 run failed" / "nothing went wrong" — and the fourth
 * case, which is neither: nothing is KEPT any more.
 *
 * total/success/failed count the rows the retention sweep has left (90 days);
 * runCount is lifetime. A schedule that has run 42 times and last ran in
 * spring therefore arrives here as `runCount 42, total 0, failed 0`, and
 * "nothing went wrong" would turn "we no longer know" into an all-clear — on
 * the card row whose whole job is to say how the unattended work has been
 * going.
 */
function failureLine(stats, t) {
    const failedRuns = stats.failed ?? 0;
    if (failedRuns === 0 && (stats.total ?? 0) === 0 && (stats.runCount ?? 0) > 0) {
        return t('cowork.stats.outside_window', 'older runs are no longer kept');
    }
    if (failedRuns === 0) return t('cowork.stats.failed_none', 'nothing went wrong');
    return t(
        failedRuns === 1 ? 'cowork.stats.failed_runs' : 'cowork.stats.failed_runs_plural',
        failedRuns === 1 ? '{count} run failed' : '{count} runs failed',
        { count: failedRuns },
    );
}

/**
 * The three cards, as data. `stats` is null while the request is in flight,
 * and then every value is an em dash and every subtitle is empty: the cards
 * keep their height so the history below them does not jump when the numbers
 * land, and an em dash cannot be misread as a measurement.
 */
function figures(stats, t) {
    const pending = '—';
    // avgDurationMs is null until something has FINISHED. Printing "0m 00s"
    // there would claim a measured instant run.
    const timed = !!stats && stats.avgDurationMs != null;
    return [
        {
            label: t('cowork.stats.runs', 'Runs'),
            value: stats ? stats.runCount : pending,
            sub: stats && stats.createdAt
                ? t('cowork.stats.since', 'since {date}', { date: monthDay(stats.createdAt) })
                : '',
        },
        {
            label: t('cowork.stats.succeeded', 'Succeeded'),
            value: stats ? stats.success : pending,
            tone: stats && stats.success > 0 ? 'var(--success-ink)' : undefined,
            sub: stats ? failureLine(stats, t) : '',
        },
        {
            label: t('cowork.stats.average', 'Average'),
            value: timed ? formatDuration(stats.avgDurationMs) : pending,
            sub: timed
                ? t('cowork.stats.per_run', 'per run')
                : (stats ? t('cowork.stats.no_runs_yet', 'no run has finished yet') : ''),
        },
    ];
}

export default function CoworkStats({ coworkId, reloadKey }) {
    const { t } = useTranslation();
    // Same "the state carries the key it was fetched for" shape as the run
    // history, for the same reason: switching items must not show the
    // previous item's numbers for a frame. Numbers are worse than rows here —
    // nothing about "42" says which item it belongs to.
    const key = `${coworkId}:${reloadKey}`;
    const [state, setState] = useState({ key: null, stats: null, failed: false });

    useEffect(() => {
        if (!coworkId) return undefined;
        let cancelled = false;
        (async () => {
            try {
                // The call is inside the try on purpose: this block is
                // supplementary, and neither a rejected promise nor a missing
                // function may take the detail pane down with it.
                const stats = await coworkApi.getCoworkStats(coworkId);
                if (!cancelled) setState({ key, stats, failed: false });
            } catch {
                if (!cancelled) setState({ key, stats: null, failed: true });
            }
        })();
        return () => { cancelled = true; };
    }, [coworkId, key]);

    const settled = state.key === key;

    if (settled && state.failed) {
        return (
            <p className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }} data-testid="cowork-stats-unavailable">
                {t('cowork.stats.unavailable', 'The figures for this work could not be loaded.')}
            </p>
        );
    }

    return (
        <div className="flex gap-3.5 flex-wrap" data-testid="cowork-stats">
            {figures(settled ? state.stats : null, t).map(card => (
                <Figure key={card.label} label={card.label} value={card.value} sub={card.sub} tone={card.tone} />
            ))}
        </div>
    );
}
