import { Check, Loader2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { expectation, medianOf, readHistory } from './timeToFirstToken';
import { useTranslation } from '../../../hooks/useTranslation';
import { StepBadge, TimelineRail } from '../../chat/MessageItem/timelineParts';
import { formatK } from './engineLine';
import { formatElapsed } from './formatElapsed';
import { useReducedMotion } from '../../../hooks/useReducedMotion';

/**
 * What the chat column shows during the silence before the first token.
 *
 * On a local model that silence is the LONGEST part of a build — two to three
 * minutes of the runtime reading a ~28k-token prompt — and it used to be
 * covered by one bare, untranslated "Thinking…" line. Nothing said the request
 * had arrived, that the connection was still alive, or how long this usually
 * takes, so the honest reading of the screen was "it hung".
 *
 * Everything on this card is something the client actually knows:
 *   - the milestones are the stream events that HAVE arrived (`state.turn`,
 *     hooks/useAutomationBuilderStream.js) — nothing is ticked on a timer;
 *   - the dot beside "reading your request" re-animates on every server
 *     heartbeat (`key={pings}` remounts it), so a dead connection shows as a
 *     dot that stopped, not as a spinner that lies;
 *   - the estimate is the median of this browser's own last waits against
 *     this model (chat/timeToFirstToken.js), and with no history the bar is a
 *     shimmer that promises nothing;
 *   - when the runtime reports how far it is through the prompt (llama-server
 *     `prompt_progress` → `turn.progress`), the bar stops guessing and shows
 *     that: processed/total as the fill, the tokens it remembered from the
 *     previous request as a lighter segment at the start — the visible proof
 *     of a prefix-cache hit. The estimate line stays as context; the "reading
 *     about 28k tokens" guess gives way to the real count.
 *
 * The row furniture is `timelineParts`, the same badges and rail as the
 * activity list that takes over once tools start landing: one stream, one
 * kind of evidence.
 */

// `formatElapsed` takes an ISO start and a `now`. A duration is the time
// since epoch zero, so one wrapper gives the running clock and the "usually
// about …" figure the very same rounding.
function formatMs(ms) {
    return Number.isFinite(ms) && ms >= 0 ? formatElapsed(new Date(0).toISOString(), ms) : null;
}

// ~4 characters per token is the working rule for these prompts; the copy
// says "about", and a figure under 1k would read as precision it is not.
function promptKTokens(chars) {
    return Number.isFinite(chars) && chars > 0 ? Math.max(1, Math.round(chars / 4 / 1000)) : null;
}

const TRACK_STYLE = { background: 'color-mix(in srgb, var(--bf-accent, var(--accent)) 18%, transparent)' };
// The remembered share: opaque and lighter than the fill it sits on, darker
// than the track — three shades, three facts (remembered / read / to go).
const CACHE_FILL = 'color-mix(in srgb, var(--bf-accent, var(--accent)) 45%, var(--bg-secondary))';
// Past this share of the prompt the runtime is about to start writing, and
// the reading row says so instead of counting heartbeats.
const NEAR_END = 0.9;

const pct = (fraction) => `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;

/**
 * llama-server's `return_progress` figures for THIS round, clamped so the bar
 * can never overshoot, or null until the first chunk (a new `round_start`
 * resets `turn.progress`, so a second round starts from the estimate again).
 */
function realProgress(turn) {
    const p = turn?.progress;
    const total = Number(p?.total) || 0;
    if (!(total > 0)) return null;
    const processed = Math.min(total, Math.max(0, Number(p.processed) || 0));
    const cache = Math.min(total, Math.max(0, Number(p.cache) || 0));
    return { total, processed, cache, fraction: processed / total, cacheFraction: cache / total, nearEnd: processed >= NEAR_END * total };
}

/** One milestone: badge (tick when done, number otherwise), label, optional sub-line. */
function MilestoneRow({ row, n, pings }) {
    const pending = row.state === 'pending';
    const live = row.state === 'live';
    return (
        <div className="flex items-start gap-2.5" data-testid={`waiting-milestone-${row.id}`} data-state={row.state}>
            <StepBadge n={row.state === 'done' ? <Check size={11} strokeWidth={3} aria-hidden="true" /> : n} muted={pending} />
            <div className="min-w-0 flex-1 pt-0.5">
                <div className={`flex items-center gap-2 text-[12px] ${pending ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`}>
                    <span className="truncate">{row.label}</span>
                    {row.id === 'reading' && live && (
                        // Remounted per heartbeat so the CSS animation plays
                        // again — a re-render alone would not restart it.
                        <span
                            key={pings}
                            className="bf-ping-tick inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{ background: 'var(--bf-accent, var(--accent))' }}
                            data-testid="waiting-ping-dot"
                            aria-hidden="true"
                        />
                    )}
                </div>
                {row.sub && <div className="text-[11px] text-[var(--text-tertiary)]">{row.sub}</div>}
            </div>
        </div>
    );
}

/**
 * Real progress when the runtime reports it; otherwise a shimmer without
 * history (`.bf-wait-bar`, index.css) or a filling track with it. The class
 * is only ever on the shimmer, so it cannot ride over a fill.
 *
 * The real bar is two layers: the accent fill at processed/total, and on top
 * of its start the lighter remembered segment at cache/total. Layered rather
 * than laid end to end so each width is one figure from the stream and the
 * fill's tween never has to move its left edge.
 */
function WaitBar({ exp, progress, reducedMotion }) {
    // A 600 ms linear tween between chunks (they come at most ~4×/s): the bar
    // glides between measurements instead of stepping. None under reduced
    // motion — the figure still updates, it just does not slide.
    const tween = reducedMotion ? 'none' : 'width 600ms linear';
    if (progress) {
        return (
            <div
                className="relative h-1 w-full overflow-hidden rounded-full"
                style={TRACK_STYLE}
                data-testid="waiting-bar"
                data-mode="determinate"
                data-source="progress"
                aria-hidden="true"
            >
                <div
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{ width: pct(progress.fraction), background: 'var(--bf-accent, var(--accent))', transition: tween }}
                    data-testid="waiting-bar-fill"
                />
                {progress.cache > 0 && (
                    <div
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{ width: pct(progress.cacheFraction), background: CACHE_FILL }}
                        data-testid="waiting-bar-cache"
                    />
                )}
            </div>
        );
    }
    if (exp.mode === 'indeterminate') {
        return <div className="bf-wait-bar h-1 w-full rounded-full" style={TRACK_STYLE} data-testid="waiting-bar" data-mode="indeterminate" aria-hidden="true" />;
    }
    return (
        <div
            className="h-1 w-full overflow-hidden rounded-full"
            style={TRACK_STYLE}
            data-testid="waiting-bar"
            data-mode="determinate"
            data-source="history"
            data-over={exp.over ? 'true' : undefined}
            aria-hidden="true"
        >
            <div
                className="h-full rounded-full"
                style={{
                    width: pct(exp.fraction),
                    background: exp.over ? 'var(--text-tertiary)' : 'var(--bf-accent, var(--accent))',
                    // A one-second linear tween between one-second ticks: the
                    // bar glides instead of stepping.
                    transition: reducedMotion ? 'none' : 'width 1s linear',
                }}
                data-testid="waiting-bar-fill"
            />
        </div>
    );
}

/**
 * The reading row's sub-line. Once the runtime is through nine tenths of the
 * prompt the next thing on the wire is the answer — say that, rather than
 * keep counting heartbeats.
 */
function readingSubline(t, progress, pings) {
    if (progress?.nearEnd) return t('routines.builder.wait.writing', 'Writing the first step…');
    return pings > 0 ? t('routines.builder.wait.heartbeats', 'connection alive · {n} heartbeats', { n: pings }) : null;
}

/**
 * Under the bar: the learned expectation, then how much is being read — the
 * real count once the runtime reports one, the ~4-chars-per-token guess from
 * `round_start` until then, nothing when neither is known.
 */
function ProgressLine({ t, exp, progress, kTokens }) {
    return (
        <div className="text-[11px] text-[var(--text-tertiary)]">
            <span data-testid="waiting-expectation">{expectationCopy(t, exp)}</span>
            {progress ? (
                <span className="tabular-nums" data-testid="waiting-progress">
                    {' · '}
                    {t('routines.builder.wait.progress', 'Reading {done} of {total} tokens', { done: formatK(progress.processed), total: formatK(progress.total) })}
                    {progress.cache > 0 && (
                        <span data-testid="waiting-remembered">
                            {' · '}
                            {t('routines.builder.wait.remembered', '{n} already remembered from last time', { n: formatK(progress.cache) })}
                        </span>
                    )}
                </span>
            ) : kTokens != null && (
                <span data-testid="waiting-prompt-size"> · {t('routines.builder.wait.prompt_size', 'Reading about {k}k tokens', { k: kTokens })}</span>
            )}
        </div>
    );
}

function expectationCopy(t, exp) {
    if (exp.mode === 'indeterminate') return t('routines.builder.wait.first_time', 'Local models take a few minutes to read the request the first time');
    const about = formatMs(exp.medianMs);
    return exp.over
        ? t('routines.builder.wait.longer', 'Taking longer than usual ({t})', { t: about })
        : t('routines.builder.wait.usually', 'Usually about {t}', { t: about });
}

export default function BuilderWaitingCard({ turn, startedAt = null, modelKey }) {
    const { t } = useTranslation();
    // `turn.sentAt` is the same instant the measurement is later taken
    // against; `startedAt` (BuildTab's render-time capture) only stands in
    // when a turn object is missing altogether.
    const sentAt = turn?.sentAt || startedAt || null;
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!sentAt) return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [sentAt]);
    const elapsedMs = sentAt ? Math.max(0, now - sentAt) : 0;

    // Read once per model key, not once per tick: this card re-renders every
    // second, and localStorage is a synchronous read on the main thread.
    const medianMs = useMemo(() => medianOf(readHistory(modelKey)), [modelKey]);
    const exp = expectation({ medianMs, elapsedMs });
    const progress = realProgress(turn);
    const reducedMotion = useReducedMotion();

    const sessionOpen = !!turn?.sessionAt;
    const pings = turn?.pings || 0;
    const kTokens = promptKTokens(turn?.promptChars);
    const rows = [
        { id: 'sent', label: t('routines.builder.wait.sent', 'Request sent'), state: 'done' },
        { id: 'session', label: t('routines.builder.wait.session', 'Session opened'), state: sessionOpen ? 'done' : 'live' },
        {
            id: 'reading',
            label: t('routines.builder.wait.reading', 'Model is reading your request'),
            state: sessionOpen ? 'live' : 'pending',
            sub: readingSubline(t, progress, pings),
        },
        { id: 'first', label: t('routines.builder.wait.first', 'First response'), state: 'pending' },
    ];

    return (
        <div
            className="self-start w-full max-w-3xl rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)]/50 px-3 py-2.5 flex flex-col gap-2.5"
            role="status"
            aria-live="polite"
            data-testid="builder-waiting-card"
        >
            <div className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
                <Loader2 size={13} className="shrink-0 animate-spin motion-reduce:animate-none" style={{ color: 'var(--bf-accent, var(--accent))' }} aria-hidden="true" />
                <b className="text-[var(--text-primary)]">{t('routines.builder.wait.title', 'Waiting for the model')}</b>
                {sentAt && <span className="tabular-nums text-[var(--text-tertiary)]" data-testid="waiting-elapsed">· {formatMs(elapsedMs)}</span>}
            </div>
            <div className="relative flex flex-col gap-1.5">
                <TimelineRail show />
                {rows.map((row, i) => <MilestoneRow key={row.id} row={row} n={i + 1} pings={pings} />)}
            </div>
            <div className="flex flex-col gap-1.5">
                <WaitBar exp={exp} progress={progress} reducedMotion={reducedMotion} />
                <ProgressLine t={t} exp={exp} progress={progress} kTokens={kTokens} />
            </div>
        </div>
    );
}
