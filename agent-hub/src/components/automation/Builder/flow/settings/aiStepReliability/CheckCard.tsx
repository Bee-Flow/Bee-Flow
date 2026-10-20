import { Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import FieldHint from '../../FieldHint';
import { cardClass } from '../formPrimitives';
import { ProblemRing } from '../runProblem';

interface Props {
    title: string;
    /** Plain-language help for the whole check, behind the (i). */
    hint?: ReactNode;
    /** The validator's reason this check cannot run, ringed in red. */
    problem?: string | null;
    onRemove: () => void;
    children: ReactNode;
}

/** One check or list of allowed values: a titled card with a remove button and an error ring. */
export function CheckCard({ title, hint, problem = null, onRemove, children }: Props) {
    const { t } = useTranslation();
    return (
        <ProblemRing problem={problem}>
            <div className={cardClass('space-y-2')} data-testid="answer-check-card">
                <div className="flex items-center gap-1.5">
                    <span className="flex-1 min-w-0 text-[12px] font-medium text-[var(--text-primary)]">{title}</span>
                    <FieldHint title={title}>{hint}</FieldHint>
                    <button
                        type="button"
                        onClick={onRemove}
                        title={t('ai_step_checks.remove', 'Remove this check')}
                        aria-label={`${t('ai_step_checks.remove', 'Remove this check')}: ${title}`}
                        className="p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-red-500/10"
                    >
                        <Trash2 size={12} />
                    </button>
                </div>
                {children}
            </div>
        </ProblemRing>
    );
}
