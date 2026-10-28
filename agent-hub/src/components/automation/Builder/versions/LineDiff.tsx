// The line changes of one long setting (code, a prompt, a message) between two
// versions: a monospace view with line numbers and a + / - gutter. Unchanged
// stretches are folded ("Show 12 unchanged lines"). Long lines wrap; the box
// scrolls on its own if it must, never the page.
import { useMemo, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { lineDiff, lineDiffStats, type LineRow } from './lineDiff';

const ROW = 'grid grid-cols-[2.75rem_2.75rem_1.25rem_minmax(0,1fr)] items-start';
const BG: Record<'add' | 'del', string> = {
    add: 'bg-[color-mix(in_srgb,var(--success)_12%,transparent)]',
    del: 'bg-[color-mix(in_srgb,var(--error)_10%,transparent)]',
};
const NUMBER = 'select-none px-1.5 text-right text-[var(--text-tertiary)]';

interface LineDiffProps {
    before: string | null;
    after: string | null;
    /** The server cut a side at its size cap. */
    truncated?: boolean;
    /** Unchanged lines kept around each change. */
    context?: number;
}

function Row({ row }: { row: LineRow }) {
    const { t } = useTranslation();
    const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : '';
    const meaning = row.kind === 'add' ? t('automation_testing.diff.added', 'Added line') : row.kind === 'del' ? t('automation_testing.diff.removed', 'Removed line') : undefined;
    return (
        <div role="row" data-kind={row.kind} className={`${ROW} ${row.kind === 'add' || row.kind === 'del' ? BG[row.kind] : ''}`}>
            <span role="cell" className={NUMBER}>{row.oldNo ?? ''}</span>
            <span role="cell" className={NUMBER}>{row.newNo ?? ''}</span>
            <span role="cell" aria-label={meaning} className="select-none text-center text-[var(--text-secondary)]">{sign}</span>
            <span role="cell" className="min-w-0 whitespace-pre-wrap break-words pr-2">{row.text || ' '}</span>
        </div>
    );
}

/** Line numbers, a +/- gutter and folded unchanged runs, for two texts. */
export default function LineDiff({ before, after, truncated = false, context = 3 }: LineDiffProps) {
    const { t } = useTranslation();
    const rows = useMemo(() => lineDiff(before, after, { context }), [before, after, context]);
    const stats = useMemo(() => lineDiffStats(rows.flatMap((r) => (r.hiddenRows ? r.hiddenRows : [r]))), [rows]);
    const [open, setOpen] = useState<Set<number>>(() => new Set());
    const unfold = (idx: number) => setOpen((s) => new Set(s).add(idx));

    return (
        <div className="space-y-1.5 text-[12px]" data-testid="line-diff">
            <p className="text-[var(--text-secondary)]">
                {t('automation_testing.diff.summary', 'Lines added: {added}. Lines removed: {removed}.', stats)}
            </p>
            <div
                role="table"
                aria-label={t('automation_testing.diff.label', 'Line changes')}
                className="max-h-[420px] overflow-auto rounded-md border border-[var(--border-default)] bg-[var(--bg-card)] py-1 font-mono leading-5 custom-scrollbar"
            >
                {rows.length === 0 && <p className="px-2 py-1 text-[var(--text-tertiary)]">{t('automation_testing.diff.empty', 'Both sides are empty.')}</p>}
                {rows.map((row, idx) => {
                    if (row.kind !== 'gap') return <Row key={idx} row={row} />;
                    if (open.has(idx)) return row.hiddenRows!.map((r, k) => <Row key={`${idx}.${k}`} row={r} />);
                    return (
                        <div role="row" key={idx} className="bg-[var(--bg-secondary)] px-2 py-0.5">
                            <button type="button" onClick={() => unfold(idx)} className="text-[var(--accent-primary)] hover:underline">
                                {t('automation_testing.diff.show_unchanged', 'Show {n} unchanged lines', { n: row.hidden })}
                            </button>
                        </div>
                    );
                })}
            </div>
            {truncated && (
                <p className="text-[var(--text-tertiary)]">{t('automation_testing.diff.truncated', 'This text is longer than what is compared here, so the end is not shown.')}</p>
            )}
        </div>
    );
}
