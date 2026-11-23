/**
 * The top of a fill-in form: the document's name (where the place around the
 * form does not show it already), whether what was typed is saved, the three
 * steps the form goes through (fill in, check, done) with the one it is at,
 * and how many fields are filled in.
 */
import { Check, CheckCircle2, FilePen } from 'lucide-react';

import type { SaveStatus } from '@/components/chat/MessageItem/useTemplateFillForm';
import useTranslation from '@/hooks/useTranslation';

/** Tailwind width steps for the progress bar (a class per tenth, no inline style). */
const WIDTHS = ['w-0', 'w-[10%]', 'w-[20%]', 'w-[30%]', 'w-[40%]', 'w-1/2', 'w-[60%]', 'w-[70%]', 'w-[80%]', 'w-[90%]', 'w-full'];

function SaveState({ status }: { status: SaveStatus }) {
    const { t } = useTranslation();
    if (status === 'idle') return null;
    const text = status === 'saving' ? t('chat_templates.form_saving', 'Saving…')
        : status === 'saved' ? t('chat_templates.form_saved', 'Saved')
            : t('chat_templates.form_save_failed', 'Not saved. Check your connection and change the field again.');
    return (
        <span role="status" data-testid="template-fill-save-state"
            className={`inline-flex items-center gap-1 text-xs ${status === 'error' ? 'text-[var(--error)]' : 'text-[var(--text-tertiary)]'}`}>
            {status === 'saved' && <Check size={12} aria-hidden="true" />}
            {text}
        </span>
    );
}

/** The three steps, joined by a line: done ones ticked, the current one filled, the ones to come outlined. */
function Stages({ at }: { at: number }) {
    const { t } = useTranslation();
    const names = [
        t('chat_templates.stage_fill', 'Fill in'), t('chat_templates.stage_check', 'Check'), t('chat_templates.stage_done', 'Done'),
    ];
    const dot = (i: number): string => {
        if (i < at || at === names.length - 1) return 'bg-[var(--success)] text-[var(--text-on-ink)]';
        return i === at ? 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)]' : 'border border-[var(--border-default)] text-[var(--text-tertiary)]';
    };
    return (
        <ol className="m-0 flex min-w-0 list-none items-center gap-1.5 p-0 text-xs" data-testid="template-fill-stages"
            aria-label={t('chat_templates.stages_label', 'The steps of this form')}>
            {names.map((name, i) => (
                <li key={name} aria-current={i === at ? 'step' : undefined} className="flex min-w-0 items-center gap-1.5">
                    {i > 0 && <span aria-hidden="true" className={`h-px w-3 shrink-0 sm:w-5 ${i <= at ? 'bg-[var(--success)]' : 'bg-[var(--border-default)]'}`} />}
                    <span aria-hidden="true" className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold leading-none ${dot(i)}`}>
                        {i < at || at === names.length - 1 ? <Check size={10} strokeWidth={3} /> : i + 1}
                    </span>
                    <span className={`truncate ${i === at ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}`}>{name}</span>
                </li>
            ))}
        </ol>
    );
}

function Progress({ filled, total }: { filled: number; total: number }) {
    const { t } = useTranslation();
    const step = total > 0 ? Math.round((filled / total) * 10) : 0;
    return (
        <div className="flex shrink-0 items-center gap-2">
            <div className="h-1.5 w-14 overflow-hidden rounded-full bg-[var(--bg-tertiary)]" aria-hidden="true">
                <div className={`h-full rounded-full bg-[var(--accent-primary)] ${WIDTHS[Math.min(Math.max(step, 0), 10)]}`} />
            </div>
            <p className="m-0 text-xs tabular-nums text-[var(--text-secondary)]" data-testid="template-fill-progress">
                {t('chat_templates.card_progress', '{filled} of {total} fields filled in', { filled, total })}
            </p>
        </div>
    );
}

export default function FillHeader({ name, showName, finished, status, filled, total, stage }: {
    name: string;
    /** False where the place around the form names the document already (the editor). */
    showName: boolean;
    finished: boolean; status: SaveStatus; filled: number; total: number;
    /** 0 fill in, 1 check, 2 done. */
    stage: number;
}) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-2.5 border-b border-[var(--border-subtle)] px-4 pb-3 pt-3.5">
            {showName && (
                <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                    <FilePen size={16} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                    <span className="truncate" title={name}>{name}</span>
                    {finished && <CheckCircle2 size={15} className="shrink-0 text-[var(--success)]" aria-label={t('chat_templates.form_finished', 'Finished')} />}
                    <span className="ml-auto shrink-0 font-normal"><SaveState status={status} /></span>
                </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <Stages at={stage} />
                <Progress filled={filled} total={total} />
            </div>
            {!showName && (status !== 'idle' || finished) && (
                <div className="flex items-center gap-2">
                    {finished && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--success)]">
                            <CheckCircle2 size={13} aria-label={t('chat_templates.form_finished', 'Finished')} />
                        </span>
                    )}
                    <SaveState status={status} />
                </div>
            )}
        </div>
    );
}
