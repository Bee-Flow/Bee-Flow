// The input part of the test-case form: type values, or take them from a
// recorded run (read-only once taken).
import type { ReactNode } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import CaptureFromRunPicker from './CaptureFromRunPicker';
import RadioRow from './RadioRow';
import type { CaseDraft } from './testCaseForm';

const FIELD = 'w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-1 text-xs outline-none focus:border-[var(--accent-primary)] aria-[invalid=true]:border-[var(--error)]';
const HELP = 'text-xs text-[var(--text-tertiary)]';
const ERROR = 'text-xs text-[var(--error)]';

interface TestCaseInputProps {
    group: string;
    automationId: string | null;
    draft: CaseDraft;
    labelOf: (name: string) => string;
    /** The case keeps the input it already has from a run. */
    keepsRecorded: boolean;
    recordedValues: Record<string, unknown> | null;
    /** The run that input came from was deleted. */
    lost: boolean;
    invalid: boolean;
    runNeeded: boolean;
    /** The server's refusal for this field, already worded. */
    refusal: ReactNode;
    onChange: (patch: Partial<CaseDraft>) => void;
    onSwitch: (kind: 'typed' | 'run') => void;
    onRecapture: () => void;
}

export default function TestCaseInput({
    group, automationId, draft, labelOf, keepsRecorded, recordedValues, lost, invalid, runNeeded, refusal, onChange, onSwitch, onRecapture,
}: TestCaseInputProps) {
    const { t } = useTranslation();
    const names = Object.keys(draft.values);
    return (
        <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-[var(--text-primary)]">{t('automation_testing.input.label', 'Input')}</legend>
            <RadioRow
                name={`${group}-input`}
                value={draft.inputKind}
                onChange={onSwitch}
                options={[
                    ['typed', t('automation_testing.input.typed', 'Type values')],
                    ['run', t('automation_testing.input.run', 'Use the input of a recorded run')],
                ]}
            />
            {draft.inputKind === 'typed' && (
                <div className="space-y-2">
                    {names.length === 0 && <p className={HELP}>{t('automation_testing.input.none', 'This code reads no inputs, so the test runs it as it is.')}</p>}
                    {names.map((n) => (
                        <label key={n} className="flex flex-col gap-1 text-xs">
                            <span className="text-[var(--text-secondary)]">{labelOf(n)}</span>
                            <input value={draft.values[n]} onChange={(e) => onChange({ values: { ...draft.values, [n]: e.target.value } })} className={`font-mono ${FIELD}`} />
                        </label>
                    ))}
                    {names.length > 0 && <p className={HELP}>{t('automation_testing.input.typed_help', 'Leave a box empty to use the default. Lists and objects can be typed as JSON.')}</p>}
                </div>
            )}
            {draft.inputKind === 'run' && keepsRecorded && (
                <div className="space-y-1.5" data-testid="test-recorded-input">
                    <p className={HELP}>{t('automation_testing.input.recorded', 'This input was taken from a run and cannot be edited here.')}</p>
                    {recordedValues && (
                        <pre className="max-h-40 overflow-auto rounded-md bg-[var(--bg-tertiary)] p-2 font-mono text-xs custom-scrollbar">{JSON.stringify(recordedValues, null, 2)}</pre>
                    )}
                    <button type="button" onClick={onRecapture} className="text-xs font-medium text-[var(--accent-primary)]">
                        {t('automation_testing.input.other_run', 'Use another run')}
                    </button>
                </div>
            )}
            {draft.inputKind === 'run' && !keepsRecorded && (
                <div className="space-y-1">
                    {lost && <p className={ERROR}>{t('automation_testing.input.lost', 'The run this input came from was deleted. Pick another run, or type values.')}</p>}
                    <CaptureFromRunPicker automationId={automationId} value={draft.runId} onChange={(runId) => onChange({ runId, attempts: null })} invalid={invalid} />
                    {runNeeded && <p className={ERROR}>{t('automation_testing.input.run_needed', 'Choose the run to take the input from.')}</p>}
                    {refusal}
                    <p className={HELP}>{t('automation_testing.input.run_help', 'The values this step received in that run are kept with the test. They are removed when the run is deleted.')}</p>
                </div>
            )}
        </fieldset>
    );
}
