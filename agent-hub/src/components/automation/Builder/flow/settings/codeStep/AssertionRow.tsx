// One check of a test case: "<where in the result> <is exactly | contains | ...> <value>".
// The path box suggests the fields of the last test result; typing is free
// (and checked with the same grammar the server reads).
import { Trash2 } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import {
    ASSERTION_OPS,
    type AssertionDraft,
    type AssertionOp,
    type AssertionProblem,
} from './testCaseForm';
import AssertionValue from './AssertionValue';
import { opLabel, valueHelp } from './assertionText';

const FIELD = 'rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-1 text-xs outline-none focus:border-[var(--accent-primary)] aria-[invalid=true]:border-[var(--error)]';

interface AssertionRowProps {
    draft: AssertionDraft;
    problem?: AssertionProblem;
    /** Fields of the last test result, offered in the path box. */
    pathChoices: string[];
    onChange: (next: AssertionDraft) => void;
    onRemove: () => void;
}

export default function AssertionRow({ draft, problem, pathChoices, onChange, onRemove }: AssertionRowProps) {
    const { t } = useTranslation();
    const listId = useId();
    const set = (patch: Partial<AssertionDraft>) => onChange({ ...draft, ...patch });

    return (
        <li className="space-y-1.5 rounded-md border border-[var(--border-subtle)] p-2" data-testid="assertion-row">
            <div className="flex items-start gap-1.5">
                <div className="min-w-0 flex-1 space-y-1">
                    <input
                        value={draft.path}
                        onChange={(e) => set({ path: e.target.value })}
                        list={pathChoices.length ? listId : undefined}
                        placeholder={t('automation_testing.path.placeholder', 'the whole result')}
                        aria-label={t('automation_testing.path.label', 'Where in the result')}
                        aria-invalid={!!problem?.path}
                        className={`w-full font-mono ${FIELD}`}
                    />
                    {pathChoices.length > 0 && <datalist id={listId}>{pathChoices.map((p) => <option key={p} value={p} />)}</datalist>}
                    {problem?.path
                        ? <p className="text-xs text-[var(--error)]">{t('automation_testing.path.invalid', 'That is not a path the checker can read. Use field names with dots, such as order.total, and [0] for the first item of a list.')}</p>
                        : <p className="text-xs text-[var(--text-tertiary)]">{t('automation_testing.path.help', 'Leave empty to check the whole result. Otherwise name a field, such as order.total or items[0].name.')}</p>}
                </div>
                <select
                    value={draft.op}
                    onChange={(e) => set({ op: e.target.value as AssertionOp })}
                    aria-label={t('automation_testing.op.label', 'Check')}
                    className={FIELD}
                >
                    {ASSERTION_OPS.map((op) => <option key={op} value={op}>{opLabel(t, op)}</option>)}
                </select>
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={t('automation_testing.assertion.remove', 'Remove this check')}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                >
                    <Trash2 size={13} aria-hidden="true" />
                </button>
            </div>
            <AssertionValue draft={draft} invalid={!!problem?.value} onChange={set} />
            <p className={`text-xs ${problem?.value ? 'text-[var(--error)]' : 'text-[var(--text-tertiary)]'}`}>
                {problem?.value === 'needed'
                    ? t('automation_testing.value.needed', 'Fill in the value this check compares with.')
                    : problem?.value === 'bad_number'
                        ? t('automation_testing.value.bad_number', 'Use a whole number from 0.')
                        : valueHelp(t, draft.op)}
            </p>
        </li>
    );
}
