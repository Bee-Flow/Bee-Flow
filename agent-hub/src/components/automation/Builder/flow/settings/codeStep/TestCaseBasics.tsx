// The name of a test and what the code is expected to do.
import type { ReactNode } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import RadioRow from './RadioRow';
import { NAME_MAX, type CaseDraft, type CaseProblems } from './testCaseForm';

const FIELD = 'w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-1 text-xs outline-none focus:border-[var(--accent-primary)] aria-[invalid=true]:border-[var(--error)]';
const HELP = 'text-xs text-[var(--text-tertiary)]';
const ERROR = 'text-xs text-[var(--error)]';

interface TestCaseBasicsProps {
    group: string;
    draft: CaseDraft;
    /** Problems to show; null before the first save attempt. */
    problems: CaseProblems | null;
    nameRefused: boolean;
    refusal: ReactNode;
    onChange: (patch: Partial<CaseDraft>) => void;
}

export default function TestCaseBasics({ group, draft, problems, nameRefused, refusal, onChange }: TestCaseBasicsProps) {
    const { t } = useTranslation();
    return (
        <>
            <div className="space-y-1">
                <label htmlFor={`${group}-name`} className="text-xs font-medium text-[var(--text-primary)]">{t('automation_testing.name.label', 'Name')}</label>
                <input
                    id={`${group}-name`}
                    value={draft.name}
                    maxLength={NAME_MAX + 20}
                    onChange={(e) => onChange({ name: e.target.value })}
                    aria-invalid={!!problems?.name || nameRefused}
                    placeholder={t('automation_testing.name.placeholder', 'For example: small order')}
                    className={FIELD}
                />
                {problems?.name
                    ? <p className={ERROR}>{problems.name === 'needed' ? t('automation_testing.name.needed', 'Give the test a name.') : t('automation_testing.name.too_long', 'Use at most {max} characters.', { max: NAME_MAX })}</p>
                    : <p className={HELP}>{t('automation_testing.name.help', 'A short name that says what this test is about.')}</p>}
                {refusal}
            </div>
            <fieldset className="space-y-1">
                <legend className="text-xs font-medium text-[var(--text-primary)]">{t('automation_testing.expect.label', 'What should happen')}</legend>
                <RadioRow
                    name={`${group}-expect`}
                    value={draft.expect}
                    onChange={(expect) => onChange({ expect })}
                    options={[
                        ['success', t('automation_testing.expect.success', 'The code succeeds')],
                        ['error', t('automation_testing.expect.error', 'The code fails with an error')],
                    ]}
                />
                <p className={HELP}>{draft.expect === 'error'
                    ? t('automation_testing.expect.error_help', 'For a test of what happens with bad input. The checks below read the error message.')
                    : t('automation_testing.expect.success_help', 'The checks below read what the code returns.')}</p>
            </fieldset>
        </>
    );
}
