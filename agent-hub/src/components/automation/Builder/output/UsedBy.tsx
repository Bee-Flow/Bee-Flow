import { ArrowRightFromLine, Plus, Repeat, Table } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { UsedByEntry } from './usedBy';

/** A family's chip colours, spelled out so Tailwind sees every class. */
const CHIP: Record<string, string> = {
    trigger: 'bg-[color-mix(in_srgb,var(--type-trigger)_14%,transparent)] text-[var(--type-trigger)]',
    ai: 'bg-[color-mix(in_srgb,var(--type-ai)_14%,transparent)] text-[var(--type-ai)]',
    app: 'bg-[color-mix(in_srgb,var(--type-app)_14%,transparent)] text-[var(--type-app)]',
    branch: 'bg-[color-mix(in_srgb,var(--type-branch)_14%,transparent)] text-[var(--type-branch)]',
    loop: 'bg-[color-mix(in_srgb,var(--type-loop)_14%,transparent)] text-[var(--type-loop)]',
    data: 'bg-[color-mix(in_srgb,var(--type-data)_14%,transparent)] text-[var(--type-data)]',
    pause: 'bg-[color-mix(in_srgb,var(--type-pause)_14%,transparent)] text-[var(--type-pause)]',
    guard: 'bg-[color-mix(in_srgb,var(--type-guard)_14%,transparent)] text-[var(--type-guard)]',
    end: 'bg-[color-mix(in_srgb,var(--type-end)_14%,transparent)] text-[var(--type-end)]',
};
const NEUTRAL_CHIP = 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]';

/** What the "what next?" buttons add after this step. */
export type NextSuggestion = 'loop' | 'datatable' | null;

interface UsedByProps {
    entries: UsedByEntry[];
    /** This step's output is a list (the suggestions talk about "each …"). */
    isList: boolean;
    /** The list holds files: "For each file" rather than "For each item". */
    fileRows?: boolean;
    /** Add a step after this one; absent on read-only surfaces. */
    onAddAfter?: ((suggestion: NextSuggestion) => void) | null;
}

const SUGGEST_BTN = 'px-2.5 py-[5px] rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] inline-flex items-center gap-[5px] hover:bg-[var(--bg-tertiary)]';

/**
 * "Used by": the later steps that really read this step's fields, or, when
 * none does yet, the question what to do with it and three ways to answer
 * (artboards 4a and 4b).
 */
export default function UsedBy({ entries, isList, fileRows = false, onAddAfter = null }: UsedByProps) {
    const { t } = useTranslation();
    if (entries.length) {
        return (
            <div className="flex items-center flex-wrap gap-2 px-3 py-[9px] rounded-lg border border-dashed border-[var(--border-default)] text-[var(--text-secondary)] text-xs" data-testid="output-used-by">
                <ArrowRightFromLine size={13} aria-hidden />
                <span>{t('routines.output.used_by', 'Used by')}</span>
                {entries.map(e => (
                    <span key={e.stepId} className="inline-flex items-center gap-1.5 min-w-0">
                        <span className={`inline-flex items-center px-[7px] rounded-full font-semibold leading-[18px] ${CHIP[e.family || ''] || NEUTRAL_CHIP}`}>
                            {e.number != null
                                ? t('routines.output.used_by_step', 'Step {n} · {label}', { n: e.number, label: e.label })
                                : e.label}
                        </span>
                        <span className="text-[var(--text-tertiary)] truncate">
                            · {e.fields.length ? e.fields.join(', ') : t('routines.output.used_whole', 'everything')}
                        </span>
                    </span>
                ))}
            </div>
        );
    }
    const question = isList
        ? t('routines.output.unused_list', 'No step uses this list yet. What do you want to do with it?')
        : t('routines.output.unused', 'No step uses this yet. What do you want to do with it?');
    return (
        <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-[10px] border border-dashed border-[var(--border-default)] text-xs" data-testid="output-used-by">
            <div className="flex items-center gap-2 text-[var(--text-secondary)]">
                <ArrowRightFromLine size={13} aria-hidden />
                {question}
            </div>
            {onAddAfter && (
                <div className="flex gap-1.5 flex-wrap">
                    {isList && (
                        <button type="button" className={SUGGEST_BTN} onClick={() => onAddAfter('loop')}>
                            <Repeat size={12} aria-hidden />
                            {fileRows
                                ? t('routines.output.suggest_each_file', 'Do something for each file')
                                : t('routines.output.suggest_each_item', 'Do something for each item')}
                        </button>
                    )}
                    {isList && (
                        <button type="button" className={SUGGEST_BTN} onClick={() => onAddAfter('datatable')}>
                            <Table size={12} aria-hidden />
                            {t('routines.output.suggest_datatable', 'Save in a datatable')}
                        </button>
                    )}
                    <button type="button" className={SUGGEST_BTN} onClick={() => onAddAfter(null)}>
                        <Plus size={12} aria-hidden />
                        {isList ? t('routines.output.suggest_other', 'Other step') : t('routines.output.suggest_next', 'Add a next step')}
                    </button>
                </div>
            )}
        </div>
    );
}
