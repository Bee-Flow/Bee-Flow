// The value control of one check: the right box for its operation.
import { useTranslation } from '@/hooks/useTranslation';
import { typeName } from './assertionText';
import { COUNT_COMPARISONS, TYPE_NAMES, type AssertionDraft } from './testCaseForm';

const FIELD = 'rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-1 text-xs outline-none focus:border-[var(--accent-primary)] aria-[invalid=true]:border-[var(--error)]';

interface AssertionValueProps {
    draft: AssertionDraft;
    invalid: boolean;
    onChange: (patch: Partial<AssertionDraft>) => void;
}

export default function AssertionValue({ draft, invalid, onChange }: AssertionValueProps) {
    const { t } = useTranslation();
    const cmpLabel = (cmp: string): string => ({
        eq: t('automation_testing.cmp.eq', 'exactly'),
        gte: t('automation_testing.cmp.gte', 'at least'),
        lte: t('automation_testing.cmp.lte', 'at most'),
    })[cmp] ?? cmp;
    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {(draft.op === 'equals' || draft.op === 'not_equals' || draft.op === 'contains') && (
                <input
                    value={draft.text}
                    onChange={(e) => onChange({ text: e.target.value })}
                    aria-label={t('automation_testing.value.label', 'Value')}
                    aria-invalid={invalid}
                    className={`min-w-0 flex-1 font-mono ${FIELD}`}
                />
            )}
            {draft.op === 'has_key' && (
                <input
                    value={draft.key}
                    onChange={(e) => onChange({ key: e.target.value })}
                    aria-label={t('automation_testing.value.key', 'Field name')}
                    aria-invalid={invalid}
                    className={`min-w-0 flex-1 font-mono ${FIELD}`}
                />
            )}
            {draft.op === 'type_is' && (
                <select value={draft.type} onChange={(e) => onChange({ type: e.target.value as AssertionDraft['type'] })} aria-label={t('automation_testing.value.type', 'Type')} className={FIELD}>
                    {TYPE_NAMES.map((name) => <option key={name} value={name}>{typeName(t, name)}</option>)}
                </select>
            )}
            {draft.op === 'count_is' && (
                <>
                    <select value={draft.cmp} onChange={(e) => onChange({ cmp: e.target.value as AssertionDraft['cmp'] })} aria-label={t('automation_testing.value.cmp', 'Comparison')} className={FIELD}>
                        {COUNT_COMPARISONS.map((c) => <option key={c} value={c}>{cmpLabel(c)}</option>)}
                    </select>
                    <input
                        value={draft.n}
                        onChange={(e) => onChange({ n: e.target.value })}
                        inputMode="numeric"
                        aria-label={t('automation_testing.value.count', 'Number of items')}
                        aria-invalid={invalid}
                        className={`w-20 ${FIELD}`}
                    />
                </>
            )}
        </div>
    );
}
