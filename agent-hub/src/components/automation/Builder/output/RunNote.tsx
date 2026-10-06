import { Check, CircleAlert } from 'lucide-react';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import { runNoteOf, type RunNote as RunNoteData } from './perItem';

/** The plain run sentence: "Ran 4 times · all worked", "Ran 64 times · 60 didn't work". */
function sentenceOf(note: RunNoteData, t: TranslateFn): string {
    const head = note.failed > 0
        ? t('automations.output.each_some_failed', "Ran {count} times · {failed} didn't work", { count: note.ran, failed: note.failed })
        : note.ran === 1
            ? t('automations.output.each_one_worked', 'Ran once · it worked')
            : t('automations.output.each_all_worked', 'Ran {count} times · all worked', { count: note.ran });
    if (note.cappedAt == null || note.total == null) return head;
    const capped = t('automations.output.each_capped', 'Stopped at the limit: {done} of {total} done', { done: note.cappedAt, total: note.total });
    return `${head} · ${capped}`;
}

/**
 * How a step that ran once per item went, in one muted line, in place of the
 * Iterations / Succeeded / Failed numbers. Renders nothing for a value
 * without those numbers (a Loop container, an ordinary list). Inline, so the
 * large view's footer can hold it in its own sentence.
 */
export default function RunNote({ value }: { value: unknown }) {
    const { t } = useTranslation();
    const note = runNoteOf(value);
    if (!note) return null;
    const broke = note.failed > 0;
    const Icon = broke ? CircleAlert : Check;
    return (
        <span
            data-testid="output-run-note"
            className={`inline-flex items-center gap-1 min-w-0 ${broke ? 'text-[var(--error)]' : 'text-[var(--text-tertiary)]'}`}
        >
            <Icon size={12} aria-hidden className="shrink-0" />
            <span className="truncate">{sentenceOf(note, t)}</span>
        </span>
    );
}
