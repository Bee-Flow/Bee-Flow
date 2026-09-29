/**
 * Every execution of one cowork item, newest first — the thing prompt tasks
 * never had. A prompt task only ever kept its *last* result, so "it stopped
 * working last Tuesday" was unanswerable.
 *
 * Fetched per item on selection rather than up front: a user with ten
 * schedules would otherwise pull ten histories to read one.
 *
 * CW-13 turned the stack of bordered cards into one table inside one card:
 * a dot, WHEN it ran, HOW LONG it took, and — the part that was missing — one
 * line saying what came out of it. The old row said "Finished · 13 Aug, 11:29
 * · run by you · 5.2s", which is four facts about the run and none about the
 * work: a run that produced a digest and a run that produced nothing were the
 * same line, and you had to open both to find out which was which.
 *
 * Where the outcome line comes from, in order:
 *   1. an error, first line only — a stack trace is not a summary;
 *   2. `producedOutput === false`, the server's own record that this run
 *      finished with nothing to report (a success, not a failure);
 *   3. the first meaningful line of the result, stripped of Markdown marks;
 *   4. and only then "no output recorded", which now means exactly that.
 *
 * `producedOutput` is three-valued: `null` is a row from before the column
 * existed and is NOT read as false — those rows fall through to their text.
 */
import { ChevronRight, History } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { listCoworkRuns } from './coworkApi';
import { formatDuration, fullTimestamp } from './coworkFormat';
import { inertMarkdownComponents, neutraliseActiveFences } from './coworkRunMarkdown';
import { runStatusToken } from './coworkStatus';
import { useTranslation } from '../../hooks/useTranslation';
import MarkdownRenderer from '../renderers/MarkdownRenderer';
import { statusLabel } from '../shared/statusTokens';

/**
 * The first line of text that carries anything, with its Markdown marks
 * taken off. Not a summary and not sold as one: a summary would be a second
 * model call per run (see CW-13's open question). This is the run's own first
 * sentence, which is what a digest opens with anyway.
 */
function firstMeaningfulLine(text) {
    for (const raw of String(text ?? '').split('\n')) {
        const line = raw
            .replace(/^\s{0,3}(?:[#>]+|[-*+]|\d+[.)])\s+/, '')  // heading, quote, bullet, number
            .replace(/^\s{0,3}[#>]+\s*/, '')                    // a bare "###" line
            .replace(/[*_`~]/g, '')                             // inline emphasis and code ticks
            .trim();
        // A line of nothing but punctuation — a "---" rule, a row of pipes —
        // is not a summary of anything. Keep looking.
        if (line && /[\p{L}\p{N}]/u.test(line)) return line;
    }
    return '';
}

/** Run statuses that mean the attempt did not succeed. */
export const FAILED_RUN_STATUSES = new Set(['error', 'failed', 'needs_reauth', 'timeout', 'cancelled']);

/** The one line the closed row shows: what came out of this run. */
function outcomeLine(run, t) {
    if (run.status === 'running') return t('cowork.history.still_running', 'Still running…');
    // The error comes FIRST, and stays first. The server writes
    // produced_output = false on every failed run, so a rule that read that
    // flag earlier would replace every failure message in this list with
    // "Nothing to report" — the reader would scan a column of calm sentences
    // over a column of broken runs.
    if (run.error) return firstMeaningfulLine(run.error) || t('cowork.history.failed_silently', 'It failed without saying why');
    // A failure that recorded no message is still a failure. Falling through
    // to "no output recorded" gave it the same words as a successful empty
    // run, in the closed list you scan precisely to spot what broke.
    if (FAILED_RUN_STATUSES.has(run.status)) return t('cowork.history.failed_silently', 'It failed without saying why');
    // The explicit record beats the text: a run whose result is the runner's
    // own "no text came back" marker DID succeed, and says so here.
    if (run.producedOutput === false) return t('cowork.history.nothing_to_report', 'Nothing to report');
    return firstMeaningfulLine(run.result) || t('cowork.history.no_output', 'No output recorded');
}

function RunRow({ run }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const status = runStatusToken(run.status);
    // Neutral states carry no token of their own; tertiary grey is what "this
    // state makes no claim" looks like — the same rule as the list rows.
    const tone = status.cssVar || 'var(--text-tertiary)';
    const duration = formatDuration(run.durationMs);

    return (
        <div data-testid="cowork-run" className="border-b last:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-[var(--bg-card-hover)]"
            >
                <span
                    aria-hidden="true"
                    className="w-[7px] h-[7px] rounded-full flex-shrink-0"
                    style={{ background: tone }}
                />
                {/* The dot is the only VISIBLE status mark in the row — the
                    design's whole point is that the outcome line does the
                    talking. A colour is not a word, though: a screen reader
                    and a colour-blind reader both get nothing from it, so the
                    word stays in the row and is only hidden from sight. */}
                <span data-status-key={status.labelKey} className="sr-only">{statusLabel(t, status)}</span>
                <span className="w-[120px] flex-shrink-0 text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>
                    {fullTimestamp(run.startedAt, t)}
                </span>
                <span
                    className="w-[64px] flex-shrink-0 text-[11px] tabular-nums"
                    style={{ color: 'var(--text-tertiary)' }}
                >
                    {duration}
                </span>
                <span className="flex-1 min-w-0 truncate text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    {outcomeLine(run, t)}
                </span>
                <ChevronRight
                    aria-hidden="true"
                    className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
                    style={{ color: 'var(--text-tertiary)' }}
                />
            </button>
            {open && (
                <div
                    className="px-3 pb-3 pt-1 text-[12.5px] break-words"
                    style={{ color: 'var(--text-secondary)' }}
                >
                    {/* Who started it moved down here from the summary line.
                        It is the one fact that is about the RUN rather than
                        about the work, and the row had four of those already. */}
                    <p className="text-[11px] pb-2" style={{ color: 'var(--text-tertiary)' }}>
                        {run.triggerKind === 'manual'
                            ? t('cowork.history.started_by_you', 'Started by you')
                            : t('cowork.history.started_on_schedule', 'Started on schedule')}
                    </p>
                    {/* A result is model output, so it arrives as Markdown —
                        headings, bullets, tables, bold. Printed raw it was a
                        wall of asterisks and pipes. A failure is not: it is a
                        stack line or an API message, and passing that through a
                        Markdown parser only mangles it.

                        The result goes through neutraliseActiveFences first,
                        and the renderer gets inertMarkdownComponents on top.
                        A run is unattended and reads untrusted material, and
                        the shared renderer turns some fence languages into live
                        components — ```map-embed``` into a third-party iframe —
                        while a plain `![](…)` is a beacon that fires the moment
                        this row is opened. Chat can afford both; a page whose
                        text was written by whatever the run happened to read
                        cannot. See coworkRunMarkdown.js. */}
                    {run.error
                        ? <div className="whitespace-pre-wrap font-mono text-[11.5px] text-[var(--error-ink)]">{run.error}</div>
                        : run.result && run.producedOutput !== false
                            ? (
                                <MarkdownRenderer
                                    content={neutraliseActiveFences(run.result)}
                                    components={inertMarkdownComponents(t)}
                                    className="cowork-run-output"
                                />
                            )
                            : <EmptyBody run={run} t={t} />}
                </div>
            )}
        </div>
    );
}

/**
 * What an opened row says when there is nothing to show.
 *
 * Three different situations used to share one sentence — "No output was
 * recorded for this run." — so a run that finished with nothing to report and
 * a run that broke without leaving a reason read word for word the same. They
 * are not the same thing and the reader has to be able to tell.
 */
function EmptyBody({ run, t }) {
    // Same order as the closed row's outcome line, and for the same reason:
    // the server writes produced_output = false on failures too, so asking
    // that question first would call every broken run "nothing to report".
    const failed = FAILED_RUN_STATUSES.has(run.status);
    const key = failed
        ? 'cowork.history.body_failed_silently'
        : (run.producedOutput === false
            ? 'cowork.history.body_nothing_to_report'
            : 'cowork.history.body_no_output');
    const english = failed
        ? 'This run failed without recording a reason.'
        : (run.producedOutput === false
            ? 'This run finished and had nothing to report.'
            : 'No output was recorded for this run.');
    return <span style={{ color: 'var(--text-tertiary)' }}>{t(key, english)}</span>;
}

/** The card frame: the heading belongs to the table, not above it. */
function HistoryCard({ t, children }) {
    return (
        <section
            className="rounded-[10px] border overflow-hidden"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', boxShadow: 'var(--shadow-sm)' }}
            data-testid="cowork-history"
        >
            <div
                className="flex items-center gap-2.5 px-3.5 py-3 border-b"
                style={{ borderColor: 'var(--border-subtle)' }}
            >
                <History aria-hidden="true" className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                <h3 className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {t('cowork.history.heading', 'What happened')}
                </h3>
            </div>
            {children}
        </section>
    );
}

export default function CoworkRunHistory({ coworkId, reloadKey }) {
    const { t } = useTranslation();
    // State carries the key it was fetched for, so "is this stale?" is derived
    // rather than announced by a setState in the effect body. Switching items
    // therefore shows the spinner immediately on the same render, instead of
    // flashing the previous item's runs for one frame.
    const key = `${coworkId}:${reloadKey}`;
    const [state, setState] = useState({ key: null, runs: [], total: 0, error: null });

    useEffect(() => {
        if (!coworkId) return undefined;
        let cancelled = false;
        listCoworkRuns(coworkId)
            .then(({ runs, total }) => {
                if (!cancelled) setState({ key, runs, total, error: null });
            })
            .catch((err) => {
                if (!cancelled) setState({ key, runs: [], total: 0, error: err.message });
            });
        return () => { cancelled = true; };
    }, [coworkId, key]);

    const note = (children, extra = {}) => (
        <p className="text-[12px] px-3.5 py-3" style={{ color: 'var(--text-tertiary)' }} {...extra}>{children}</p>
    );

    let body;
    if (state.key !== key) {
        body = note(t('cowork.history.loading', 'Loading history…'));
    } else if (state.error) {
        body = (
            <p className="text-[12px] px-3.5 py-3 text-[var(--error-ink)]" role="alert">{state.error}</p>
        );
    } else if (state.runs.length === 0) {
        body = note(
            t('cowork.history.empty', 'This hasn’t run yet. The history fills in after the first run.'),
            { 'data-testid': 'cowork-no-runs' },
        );
    } else {
        body = (
            <div data-testid="cowork-run-list">
                {state.runs.map(run => <RunRow key={run.id} run={run} />)}
                {state.total > state.runs.length && (
                    <p className="text-[11px] px-3.5 py-2.5" style={{ color: 'var(--text-tertiary)' }}>
                        {t(
                            'cowork.history.truncated',
                            'Showing the {shown} most recent of {total} runs.',
                            { shown: state.runs.length, total: state.total },
                        )}
                    </p>
                )}
            </div>
        );
    }

    return <HistoryCard t={t}>{body}</HistoryCard>;
}
