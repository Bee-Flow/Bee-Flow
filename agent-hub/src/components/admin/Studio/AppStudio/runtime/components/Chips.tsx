import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { walkPath } from '../resolveBinding';
import { displayValue } from '../uiBits';
import { rowFile } from './openAttachment';
import type { ChipsProps } from './AppMessageThread.types';

/**
 * How many chips a message shows before it asks. One order in the app this was
 * built for arrived as a zip that unpacked to 243 drawings, all hanging off a
 * single mail: rendered flat, the chips buried the conversation and pushed the
 * reply box off-screen. A message says what came with it; the file list itself
 * belongs in a gallery.
 */
const CHIP_CAP = 6;

export function Chips({ items, labelKey, testId, fileKey, onOpen }: ChipsProps) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    const [busy, setBusy] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return null;
    const shown = expanded ? list : list.slice(0, CHIP_CAP);
    const hidden = list.length - shown.length;
    return (
        <div
            className={`flex flex-wrap gap-1 mt-1.5${expanded ? ' max-h-40 overflow-y-auto' : ''}`}
            data-app-thread-chips={testId}
            data-app-thread-chips-total={list.length}
        >
            {shown.map((item, i) => {
                const label = typeof item === 'string' ? item : displayValue(walkPath(item, labelKey));
                if (label == null || label === '') return null;
                const chipClass = 'inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded [background:var(--bg-secondary)] [color:var(--text-secondary)]!';
                // Only a row that carries a file can be opened; a plain label stays a label.
                const openable = !!onOpen && !!fileKey && typeof item === 'object' && !!rowFile(item, fileKey, walkPath);
                if (!openable) return <span key={i} className={chipClass}>{label}</span>;
                return (
                    <button
                        key={i}
                        type="button"
                        className={`${chipClass} cursor-pointer hover:underline disabled:opacity-60`}
                        disabled={busy === i}
                        aria-busy={busy === i}
                        data-app-thread-chip-open="true"
                        onClick={async (e) => {
                            // The bubble may itself sit in a clickable row button.
                            e.stopPropagation();
                            setBusy(i);
                            setError(null);
                            try { await onOpen(item); } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
                        }}
                    >
                        {label}
                    </button>
                );
            })}
            {(hidden > 0 || expanded) && (
                <button
                    type="button"
                    onClick={() => setExpanded(!expanded)}
                    className="inline-flex items-center px-1.5 py-0.5 text-[11px] rounded font-medium [background:var(--bg-secondary)] [color:var(--app-primary)]!"
                    data-app-thread-chips-toggle={expanded ? 'less' : 'more'}
                >
                    {expanded ? t('studio_apps_runtime.thread.show_less', 'Show less') : t('studio_apps_runtime.thread.more', '+{n} more', { n: hidden })}
                </button>
            )}
            {error && <span role="alert" className="w-full text-[11px] text-[var(--error-ink)]">{error}</span>}
        </div>
    );
}
