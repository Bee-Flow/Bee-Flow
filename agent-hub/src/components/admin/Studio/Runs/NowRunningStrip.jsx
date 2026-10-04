import { Activity, AlertCircle, Loader2 } from 'lucide-react';
import React from 'react';
import { nowRunningLines } from './nowRunning';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import { useTranslation } from '../../../../hooks/useTranslation';
import { errorClassLabel } from '../Executions/runLanguage';
import { nOf } from '../KnowledgeStudio/plural';

/**
 * "Now running · last 24 hours" — the strip at the top of Studio → Runs & log
 * (Studio.dc.html 1a).
 *
 * One line per automation that ran in the window: a coloured dot, the name, one
 * phrase, and how long ago. The model is in nowRunning.js and tested there;
 * this file is the drawing plus the three states the drawing has to keep
 * apart.
 *
 * ── The three states, and why none of them may borrow another's look ─────
 *
 *   LOADING     the first read has not answered. A spinner, no lines.
 *   UNREADABLE  `lines` is null: the read failed, or the server has no
 *               rollup. Says so, in words. It must never render as "nothing
 *               is running": the whole value of a strip somebody glances at
 *               is that a quiet one means a quiet organisation.
 *   READ        an array, possibly empty. Empty is a real answer and gets its
 *               own sentence.
 *
 * The window is FIXED at 24 hours and does not follow the table's range chip
 * below it. The heading says "last 24 hours"; a strip that silently became
 * "last 30 days" because someone widened the table would be a heading that
 * lies about its own numbers.
 */

/** dot colour + text tone per state. Four states, one table. */
const TONE = Object.freeze({
    error: { dot: 'var(--error)', ink: 'var(--error-ink, var(--error))' },
    waiting: { dot: 'var(--warning)', ink: 'var(--warning-ink, var(--warning))' },
    running: { dot: 'var(--accent-primary)', ink: 'var(--text-secondary)' },
    done: { dot: 'var(--success)', ink: 'var(--text-tertiary)' },
});

/** The phrase after the automation's name. */
function lineText(line, t) {
    if (line.tone === 'error') {
        // The CLASS, in plain words — never the free-text message, which can
        // quote a customer and, in the organisation scope, somebody else's.
        // "Open the run" is where the detail lives, for whoever owns it.
        const why = errorClassLabel(line.errorClass);
        return why
            ? t('runs.now.failed_because', 'failed — {reason}', { reason: why })
            : t('runs.now.failed', 'failed');
    }
    if (line.tone === 'waiting') {
        return nOf(t, 'runs.now.waiting', line.waiting, 'waiting for a person', '{count} waiting for a person');
    }
    if (line.tone === 'running') {
        return nOf(t, 'runs.now.running', line.running, 'running now', '{count} running now');
    }
    return nOf(t, 'runs.now.done', line.total, 'done · {count} run', 'done · {count} runs');
}

function StripLine({ line, onOpen }) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const tone = TONE[line.tone] || TONE.done;
    const title = line.title || t('runs.now.untitled', 'An automation without a name');
    return (
        <li className="flex items-center gap-2 text-xs" data-testid="now-running-line" data-tone={line.tone}>
            <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: tone.dot }}
                aria-hidden="true"
            />
            {onOpen ? (
                <button
                    type="button"
                    onClick={() => onOpen(line.automationId)}
                    className="font-medium truncate max-w-[45%] text-left hover:underline"
                    style={{ color: 'var(--text-primary)' }}
                    data-testid="now-running-open"
                >
                    {title}
                </button>
            ) : (
                <span className="font-medium truncate max-w-[45%]" style={{ color: 'var(--text-primary)' }}>{title}</span>
            )}
            <span className="truncate" style={{ color: tone.ink }}>{lineText(line, t)}</span>
            <span className="ml-auto shrink-0 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
                {line.at ? rel(line.at) : ''}
            </span>
        </li>
    );
}

/**
 * `facets` is the raw facets body (or null). `loading` is only true while the
 * FIRST read is in flight — a refresh keeps the previous lines on screen
 * rather than blanking a strip somebody is reading.
 */
export default function NowRunningStrip({ facets = null, loading = false, failed = false, onOpenAutomation = null }) {
    const { t } = useTranslation();
    const model = nowRunningLines(facets);

    return (
        <section
            className="rounded-xl border p-4 flex flex-col gap-2.5"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}
            data-testid="now-running"
        >
            <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                <Activity className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                {t('runs.now.title', 'Now running')}
                <span className="ml-auto text-xs font-normal" style={{ color: 'var(--text-tertiary)' }}>
                    {t('runs.now.window', 'last 24 hours')}
                </span>
            </div>

            {loading && !model ? (
                <div className="flex items-center justify-center py-3" role="status" data-testid="now-running-loading">
                    <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                </div>
            ) : !model ? (
                /* UNREADABLE — never "nothing is running". A strip people
                   glance at has to be able to say it does not know. */
                <div className="flex items-start gap-2 text-xs" style={{ color: 'var(--text-secondary)' }} data-testid="now-running-unknown">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: 'var(--warning)' }} aria-hidden="true" />
                    <span>
                        {failed
                            ? t('runs.now.unreadable', 'Could not read what is running — this is not “nothing is running”.')
                            : t('runs.now.unsupported', 'This server did not report per-automation activity, so this strip has nothing to show. The runs below are unaffected.')}
                    </span>
                </div>
            ) : model.lines.length === 0 ? (
                <div className="text-xs" style={{ color: 'var(--text-tertiary)' }} data-testid="now-running-empty">
                    {t('runs.now.empty', 'Nothing has run in the last 24 hours.')}
                </div>
            ) : (
                <>
                    <ul className="flex flex-col gap-1.5 list-none p-0 m-0" data-testid="now-running-list">
                        {model.lines.map(line => (
                            <StripLine key={line.automationId} line={line} onOpen={onOpenAutomation} />
                        ))}
                    </ul>
                    {model.hidden > 0 && (
                        <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }} data-testid="now-running-more">
                            {nOf(t, 'runs.now.more', model.hidden, 'and {count} more automation', 'and {count} more automations')}
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
