// The checks on a test's result, as rows with an "Add a check" button.
import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import AssertionRow from './AssertionRow';
import { newAssertion, type CaseDraft, type CaseProblems } from './testCaseForm';

interface TestCaseAssertionsProps {
    draft: CaseDraft;
    problems: CaseProblems | null;
    pathChoices: string[];
    maxAssertions: number;
    refusal: ReactNode;
    onChange: (patch: Partial<CaseDraft>) => void;
}

export default function TestCaseAssertions({ draft, problems, pathChoices, maxAssertions, refusal, onChange }: TestCaseAssertionsProps) {
    const { t } = useTranslation();
    return (
        <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-[var(--text-primary)]">{t('automation_testing.assertions.label', 'Checks on the result')}</legend>
            <p className="text-xs text-[var(--text-tertiary)]">{t('automation_testing.assertions.help', 'Each check says something that must be true about the result. A test passes when the code did what you expect and every check holds.')}</p>
            {draft.assertions.length > 0 && (
                <ul className="space-y-2">
                    {draft.assertions.map((a) => (
                        <AssertionRow
                            key={a.id}
                            draft={a}
                            problem={problems?.assertions[a.id]}
                            pathChoices={pathChoices}
                            onChange={(next) => onChange({ assertions: draft.assertions.map((x) => (x.id === a.id ? next : x)) })}
                            onRemove={() => onChange({ assertions: draft.assertions.filter((x) => x.id !== a.id) })}
                        />
                    ))}
                </ul>
            )}
            <button
                type="button"
                onClick={() => onChange({ assertions: [...draft.assertions, newAssertion()] })}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] px-2 py-1 text-xs"
            >
                <Plus size={12} aria-hidden="true" />{t('automation_testing.assertions.add', 'Add a check')}
            </button>
            {problems?.tooManyAssertions && <p className="text-xs text-[var(--error)]">{t('automation_testing.assertions.too_many', 'A test can have at most {max} checks.', { max: maxAssertions })}</p>}
            {refusal}
        </fieldset>
    );
}
