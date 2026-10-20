// Make or change one test case: a name, what the code is expected to do, the
// input it gets (typed in, or taken from a recorded run) and the checks on its
// result. No code is needed: every part is a form field with its own help.
import { Loader2 } from 'lucide-react';
import { useId, useState } from 'react';
import type { CodeParam } from '../../../../../../api/queries/automation/codeStep';
import {
    testCaseErrorCode,
    testCaseErrorField,
    useCreateTestCase,
    useTestCaseInput,
    useUpdateTestCase,
    type TestCase,
    type TestCaseErrorField,
} from '../../../../../../api/queries/automation/testCases';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { serverRefusal } from './assertionText';
import TestCaseAssertions from './TestCaseAssertions';
import TestCaseBasics from './TestCaseBasics';
import TestCaseInput from './TestCaseInput';
import {
    bodyFromDraft,
    caseProblems,
    defaultValues,
    draftFrom,
    isCaseValid,
    type CaseDraft,
} from './testCaseForm';

const HELP = 'text-xs text-[var(--text-tertiary)]';
const ERROR = 'text-xs text-[var(--error)]';

export interface TestCaseEditorProps {
    automationId: string | null;
    stepId: string;
    params: CodeParam[];
    /** Inputs the code reads without declaring them (they get a box too). */
    otherNames?: string[];
    /** The case being changed; none for a new one. */
    existing?: TestCase | null;
    /** A run to take the input from, for "Save as test case". */
    run?: { runId: string; attempts?: number | null } | null;
    /** Fields of the last test result, offered as paths. */
    pathChoices?: string[];
    /** The most checks one case may hold (0 = no limit). */
    maxAssertions?: number;
    onClose: () => void;
    onSaved?: (saved: TestCase | null) => void;
}

export default function TestCaseEditor({
    automationId, stepId, params, otherNames = [], existing = null, run = null, pathChoices = [], maxAssertions = 0, onClose, onSaved,
}: TestCaseEditorProps) {
    const { t } = useTranslation();
    const group = useId();
    const [draft, setDraft] = useState<CaseDraft>(() => draftFrom({ params, otherNames, existing, run }));
    const [attempted, setAttempted] = useState(false);
    const [refusal, setRefusal] = useState<{ field: TestCaseErrorField; message: string } | null>(null);
    const [recapture, setRecapture] = useState(false);
    const create = useCreateTestCase(automationId);
    const update = useUpdateTestCase(automationId);

    // A recorded input that is still there is kept as it is, until another run is picked.
    const keepsRecorded = !!existing && existing.input.kind === 'run' && existing.input.available && draft.inputKind === 'run' && !recapture;
    const recorded = useTestCaseInput(automationId, keepsRecorded ? existing!.id : null);
    const problems = caseProblems(draft, maxAssertions, keepsRecorded);
    const busy = create.isPending || update.isPending;
    const set = (patch: Partial<CaseDraft>) => { setDraft((d) => ({ ...d, ...patch })); setRefusal(null); };
    const show = attempted ? problems : null;

    const save = async () => {
        setAttempted(true);
        if (!isCaseValid(problems)) return;
        try {
            const body = bodyFromDraft(draft, keepsRecorded);
            const saved = existing
                ? await update.mutateAsync({ caseId: existing.id, body })
                : await create.mutateAsync({ ...body, stepId });
            onSaved?.(saved);
            onClose();
        } catch (err) {
            const message = err instanceof Error ? err.message : '';
            setRefusal({
                field: testCaseErrorField(err),
                message: serverRefusal(t, testCaseErrorCode(err), message || t('automation_testing.error.save', 'The test could not be saved. Try again in a moment.')),
            });
        }
    };

    const refusalAt = (field: TestCaseErrorField) => (refusal?.field === field
        ? <p role="alert" className={ERROR} data-testid={`test-error-${field}`}>{refusal.message}</p>
        : null);
    const switchInput = (kind: 'typed' | 'run') => {
        // Typed values start from the parameters' defaults; nothing from a run is copied over.
        set(kind === 'typed' ? { inputKind: 'typed', values: defaultValues(params, otherNames) } : { inputKind: 'run' });
    };
    const labelOf = (n: string) => params.find((p) => p.name === n)?.label || n;
    const lost = !!existing && existing.input.kind === 'run' && !existing.input.available && draft.inputKind === 'run';

    return (
        <form
            className="space-y-4 p-3"
            data-testid="test-case-editor"
            onSubmit={(e) => { e.preventDefault(); void save(); }}
            aria-label={existing ? t('automation_testing.editor.title_edit', 'Edit test') : t('automation_testing.editor.title_new', 'New test')}
        >
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                {existing ? t('automation_testing.editor.title_edit', 'Edit test') : t('automation_testing.editor.title_new', 'New test')}
            </h3>
            {run && !existing && (
                <p className={HELP}>{t('automation_testing.editor.from_run_hint', 'The input of this step in this run is kept as test data. Add checks below so the test can tell when the result is wrong.')}</p>
            )}

            <TestCaseBasics
                group={group}
                draft={draft}
                problems={show}
                nameRefused={refusal?.field === 'name'}
                refusal={refusalAt('name')}
                onChange={set}
            />

            <TestCaseInput
                group={group}
                automationId={automationId}
                draft={draft}
                labelOf={labelOf}
                keepsRecorded={keepsRecorded}
                recordedValues={recorded.data?.input.values ?? null}
                lost={lost}
                invalid={!!show?.input || refusal?.field === 'input'}
                runNeeded={!!show?.input}
                refusal={refusalAt('input')}
                onChange={set}
                onSwitch={switchInput}
                onRecapture={() => setRecapture(true)}
            />

            <TestCaseAssertions draft={draft} problems={show} pathChoices={pathChoices} maxAssertions={maxAssertions} refusal={refusalAt('assertions')} onChange={set} />

            {refusalAt('general')}
            <div className="flex items-center gap-2">
                <button
                    type="submit"
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-medium text-[var(--accent-primary-fg)] disabled:opacity-40"
                >
                    {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                    {t('automation_testing.editor.save', 'Save test')}
                </button>
                <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
                    {t('automation_testing.editor.cancel', 'Cancel')}
                </button>
            </div>
        </form>
    );
}
