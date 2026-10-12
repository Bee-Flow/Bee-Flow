import { useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useTranslation } from '../../../hooks/useTranslation';
import type { TranslateFn } from '../../../hooks/useTranslation';
import { formatBytes } from '../../../utils/dateFormatters';
import { fetchRunFullOutput, fullOutputRefOf, type FullOutputRef } from '../../../api/queries/runFullOutput';

/**
 * A step output the run history had to cut short (BFSF-402).
 *
 * The history keeps at most 256 KB of a step's output and stores the rest as a
 * sentinel, `{ __truncated__, originalBytes, headSample }`
 * (server/automation/payloadTruncation.js). Rendered as an ordinary object it
 * read as three anonymous fields, as if that were the step's answer, and the
 * notice that replaced them could only show the 1 KB head and advise a re-run
 * that wrote the same stub again.
 *
 * When the server kept a full copy beside the row, the sentinel names it
 * (`fullOutputRef`) and this offers it: loaded on request, then handed to
 * `renderFull`, which OutputView points back at itself so the whole output
 * gets the same Table and JSON views, drill-down and search as any other.
 * Without a copy (older rows, or an output above the copy limit) it says so
 * plainly and shows the head sample.
 *
 * The panels that render this are reused when the person picks another step
 * or another attempt, so every load is tied to the run-step row it was made
 * for: a copy loaded (or still loading) for one row is never shown under the
 * next one.
 */

type LoadState =
    | { status: 'idle' }
    | { status: 'loading'; key: string }
    | { status: 'failed'; key: string }
    | { status: 'loaded'; key: string; value: unknown };

const IDLE: LoadState = { status: 'idle' };

/** The run-step row a kept copy belongs to, as one comparable string. */
function rowKeyOf(ref: FullOutputRef | null): string | null {
    return ref ? JSON.stringify([ref.runId, ref.stepId, ref.attempts]) : null;
}

/**
 * The load state of the row on screen now. Anything else is left over from
 * the row the panel showed before, and reads as idle.
 */
function loadFor(state: LoadState, key: string | null): LoadState {
    return state.status !== 'idle' && state.key === key ? state : IDLE;
}

export interface TruncatedOutputProps {
    /** The persisted sentinel. */
    sentinel: Record<string, unknown>;
    /** Renders the full output once it is loaded. */
    renderFull: (value: unknown) => ReactNode;
    /** Grow to fill the parent and scroll inside, like OutputView's `fill`. */
    fill?: boolean;
    /** Draw the notice in its own card (false when already inside one). */
    framed?: boolean;
}

export default function TruncatedOutput({ sentinel, renderFull, fill = false, framed = true }: TruncatedOutputProps) {
    const { t } = useTranslation();
    const [state, setLoad] = useState<LoadState>(IDLE);
    const ref = fullOutputRefOf(sentinel);
    const key = rowKeyOf(ref);
    const load = loadFor(state, key);
    const bytes = Number(sentinel.originalBytes);
    const size = Number.isFinite(bytes) && bytes > 0 ? formatBytes(bytes) : null;
    const sample = typeof sentinel.headSample === 'string' ? sentinel.headSample : '';

    const showFull = async () => {
        if (!ref || !key) return;
        setLoad({ status: 'loading', key });
        // An answer that arrives after the panel moved on to another row is
        // dropped rather than shown.
        const settle = (next: LoadState) => setLoad((prev) => (prev.status === 'loading' && prev.key === key ? next : prev));
        try {
            const value = await fetchRunFullOutput(ref);
            settle(value == null ? { status: 'failed', key } : { status: 'loaded', key, value });
        } catch {
            settle({ status: 'failed', key });
        }
    };

    if (load.status === 'loaded') {
        return (
            <div className={fill ? 'flex flex-col flex-1 min-h-0 gap-1' : 'space-y-1'}>
                <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)] shrink-0">
                    <span>
                        {size
                            ? t('automations.output.truncated.showing_full', { size })
                            : t('automations.output.truncated.showing_full_plain')}
                    </span>
                    <button type="button" onClick={() => setLoad(IDLE)} className="text-[var(--accent)] hover:underline">
                        {t('automations.output.truncated.show_sample')}
                    </button>
                </div>
                {renderFull(load.value)}
            </div>
        );
    }

    const frame = framed
        ? `rounded border border-[var(--border-default)] bg-[var(--bg-secondary)]/30 overflow-auto custom-scrollbar text-xs p-1.5 ${fill ? 'flex-1 min-h-0' : 'mt-1 max-h-72'}`
        : '';
    return (
        <div className={frame}>
            <div className="space-y-1.5">
                <Notice
                    t={t}
                    title={size && sample
                        ? t('automations.output.truncated.title_sized', { size, kept: formatBytes(sample.length) })
                        : t('automations.output.truncated.title')}
                    canLoad={!!ref}
                    status={load.status}
                    onLoad={() => { void showFull(); }}
                />
                {sample && (
                    <div>
                        <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)] mb-0.5">
                            {t('automations.output.truncated.kept_label')}
                        </div>
                        <pre className="whitespace-pre-wrap break-words font-mono text-[10px] text-[var(--text-primary)]">{sample}</pre>
                    </div>
                )}
            </div>
        </div>
    );
}

interface NoticeProps {
    t: TranslateFn;
    title: string;
    /** A full copy exists and can be fetched. */
    canLoad: boolean;
    status: LoadState['status'];
    onLoad: () => void;
}

/** What happened, in words, and — when a full copy was kept — the way to it. */
function Notice({ t, title, canLoad, status, onLoad }: NoticeProps) {
    const loading = status === 'loading';
    return (
        <div className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
                <div className="font-medium">{title}</div>
                <div className="mt-0.5 opacity-80">
                    {t('automations.output.truncated.body')}{' '}
                    {canLoad ? t('automations.output.truncated.full_kept') : t('automations.output.truncated.no_copy')}
                </div>
                {canLoad && (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onLoad(); }}
                            disabled={loading}
                            className="inline-flex items-center gap-1 rounded border border-amber-500/50 px-1.5 py-0.5 font-medium hover:bg-amber-500/15 disabled:opacity-60"
                        >
                            {loading && <Loader2 size={11} className="animate-spin" />}
                            {loading ? t('automations.output.truncated.loading') : t('automations.output.truncated.show_full')}
                        </button>
                        {status === 'failed' && <span role="status">{t('automations.output.truncated.load_failed')}</span>}
                    </div>
                )}
            </div>
        </div>
    );
}
