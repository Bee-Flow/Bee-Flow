// The Tests tab of the large code editor: the step's test cases, "Run all
// tests", and what each run found. Tests run the code as it stands in the
// editor, saved or not, in the same closed sandbox as "Try it": nothing is sent
// anywhere.
import { FlaskConical, Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { CodeParam } from '../../../../../../api/queries/automation/codeStep';
import {
    useDeleteTestCase,
    useRunTestCases,
    useTestCases,
    type TestCase,
    type TestRunResponse,
    type TestRunResult,
    type TestStatus,
} from '../../../../../../api/queries/automation/testCases';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { STATUS_LABEL } from './assertionText';
import TestCaseEditor from './TestCaseEditor';
import TestCaseResult from './TestCaseResult';
import { pathChoices } from './testCaseForm';

const BADGE: Record<TestStatus | 'never', string> = {
    pass: 'bg-[var(--success)]/10 text-[var(--success)]',
    fail: 'bg-[var(--error)]/10 text-[var(--error)]',
    error: 'bg-[var(--error)]/10 text-[var(--error)]',
    unusable: 'bg-[var(--warning)]/10 text-[var(--warning)]',
    never: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
};

interface CodeTestsPanelProps {
    automationId: string | null;
    stepId: string | null;
    /** The editor's current text, so unsaved code is the code that is tested. */
    code: string;
    params: CodeParam[];
    /** Inputs the code reads without declaring them. */
    otherInputs?: string[];
}

function StatusBadge({ status }: { status: TestStatus | null }) {
    const { t } = useTranslation();
    const [key, english] = STATUS_LABEL[status ?? 'never'];
    return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${BADGE[status ?? 'never']}`} data-testid="test-status">{t(key, english)}</span>;
}

interface CaseRowProps {
    testCase: TestCase;
    result: TestRunResult | undefined;
    running: boolean;
    busy: boolean;
    onRun: () => void;
    onEdit: () => void;
    onDelete: () => void;
}

function CaseRow({ testCase, result, running, busy, onRun, onEdit, onDelete }: CaseRowProps) {
    const { t } = useTranslation();
    const [confirming, setConfirming] = useState(false);
    const source = testCase.input.kind === 'typed'
        ? t('automation_testing.source.typed', 'Typed values')
        : testCase.input.available
            ? t('automation_testing.source.run', 'Captured from a run')
            : t('automation_testing.source.lost', 'The run this input came from was deleted');
    const lost = testCase.input.kind === 'run' && !testCase.input.available;
    return (
        <li className="space-y-2 rounded-md border border-[var(--border-subtle)] p-2.5" data-testid="test-case-row">
            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[var(--text-primary)]" title={testCase.name}>{testCase.name}</p>
                    <p className={`text-xs ${lost ? 'text-[var(--warning)]' : 'text-[var(--text-tertiary)]'}`}>{source}</p>
                </div>
                <StatusBadge status={result?.status ?? testCase.lastStatus} />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" onClick={onRun} disabled={busy} aria-label={t('automation_testing.case.run_named', 'Run {name}', { name: testCase.name })} className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] px-2 py-1 text-xs disabled:opacity-40">
                    {running ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}
                    {t('automation_testing.case.run', 'Run')}
                </button>
                <button type="button" onClick={onEdit} aria-label={t('automation_testing.case.edit_named', 'Edit {name}', { name: testCase.name })} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
                    <Pencil size={12} aria-hidden="true" />{t('automation_testing.case.edit', 'Edit')}
                </button>
                {confirming ? (
                    <>
                        <button type="button" onClick={onDelete} className="rounded-md bg-[var(--error)] px-2 py-1 text-xs font-medium text-white">{t('automation_testing.case.delete_confirm', 'Delete it')}</button>
                        <button type="button" onClick={() => setConfirming(false)} className="rounded-md px-2 py-1 text-xs text-[var(--text-secondary)]">{t('automation_testing.case.keep', 'Keep')}</button>
                    </>
                ) : (
                    <button type="button" onClick={() => setConfirming(true)} aria-label={t('automation_testing.case.delete_named', 'Delete {name}', { name: testCase.name })} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
                        <Trash2 size={12} aria-hidden="true" />{t('automation_testing.case.delete', 'Delete')}
                    </button>
                )}
            </div>
            {result && <TestCaseResult result={result} testCase={testCase} />}
        </li>
    );
}

interface PanelNoticesProps {
    atLimit: boolean;
    limit: number;
    summary: TestRunResponse['summary'] | null;
    runFailed: boolean;
    deleteFailed: boolean;
    loading: boolean;
    loadFailed: boolean;
    empty: boolean;
}

/** The messages between the buttons and the list: limit, summary, failures, loading and the empty state. */
function PanelNotices({ atLimit, limit, summary, runFailed, deleteFailed, loading, loadFailed, empty }: PanelNoticesProps) {
    const { t } = useTranslation();
    return (
        <>
            {atLimit && <p className="text-xs text-[var(--text-tertiary)]">{t('automation_testing.panel.limit', 'This step has {n} tests, the most it can keep.', { n: limit })}</p>}
            {summary && (
                <p className="text-xs font-medium text-[var(--text-primary)]" data-testid="test-summary">
                    {t('automation_testing.panel.summary', '{passed} passed, {failed} failed, {errored} with an error, {unusable} could not run', summary)}
                </p>
            )}
            {runFailed && <p role="alert" className="text-xs text-[var(--error)]">{t('automation_testing.panel.run_failed', 'The tests could not run just now. Try again in a moment.')}</p>}
            {deleteFailed && <p role="alert" className="text-xs text-[var(--error)]">{t('automation_testing.panel.delete_failed', 'The test could not be deleted. Try again in a moment.')}</p>}
            {loading && <p className="text-xs italic text-[var(--text-secondary)]">{t('automation_testing.panel.loading', 'Loading tests…')}</p>}
            {loadFailed && <p className="text-xs text-[var(--text-secondary)]">{t('automation_testing.panel.load_failed', 'The tests could not be loaded just now.')}</p>}
            {!loading && !loadFailed && empty && (
                <div className="flex items-start gap-2 rounded-md border border-dashed border-[var(--border-subtle)] p-3 text-xs text-[var(--text-secondary)]">
                    <FlaskConical size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <p>{t('automation_testing.panel.empty', 'No tests yet. Add one with typed values, or save the input of a real run as a test, then say what the result should look like.')}</p>
                </div>
            )}
        </>
    );
}

export default function CodeTestsPanel({ automationId, stepId, code, params, otherInputs = [] }: CodeTestsPanelProps) {
    const { t } = useTranslation();
    const list = useTestCases(automationId, stepId);
    const run = useRunTestCases(automationId);
    const remove = useDeleteTestCase(automationId);
    const [editing, setEditing] = useState<TestCase | null | 'new'>(null);
    const [results, setResults] = useState<Record<string, TestRunResult>>({});
    const [runningId, setRunningId] = useState<string | 'all' | null>(null);
    const cases = list.data?.testCases || [];
    const limit = list.data?.limits.perStep || 0;
    const atLimit = limit > 0 && cases.length >= limit;

    // Fields of the last result that gave a value, offered when writing a check.
    const choices = useMemo(() => {
        const withValue = Object.values(results).find((r) => r.hasResult && !r.error && r.result != null);
        return withValue ? pathChoices(withValue.result) : [];
    }, [results]);

    if (!automationId || !stepId) {
        return <p className="p-3 text-sm text-[var(--text-secondary)]">{t('automation_testing.unsaved', 'Save the automation first. Tests belong to a saved step.')}</p>;
    }

    // mutate, not mutateAsync: a failed run is shown through run.isError, so there is no error to catch here.
    const runCases = (caseIds?: string[]) => {
        setRunningId(caseIds?.length === 1 ? caseIds[0] : 'all');
        run.mutate({ stepId, ...(caseIds ? { caseIds } : {}), code }, {
            onSuccess: (out) => {
                setResults((prev) => ({ ...(caseIds ? prev : {}), ...Object.fromEntries(out.results.map((r) => [r.caseId, r])) }));
            },
            onSettled: () => setRunningId(null),
        });
    };

    if (editing) {
        const existing = editing === 'new' ? null : editing;
        return (
            <div className="h-full min-h-0 overflow-auto custom-scrollbar">
                <TestCaseEditor
                    key={existing?.id ?? 'new'}
                    automationId={automationId}
                    stepId={stepId}
                    params={params}
                    otherNames={otherInputs}
                    existing={existing}
                    pathChoices={choices}
                    maxAssertions={list.data?.limits.assertions || 0}
                    onClose={() => setEditing(null)}
                />
            </div>
        );
    }

    const summary = run.data && runningId === null ? run.data.summary : null;
    return (
        <div className="h-full min-h-0 space-y-3 overflow-auto p-3 custom-scrollbar" data-testid="code-tests-panel">
            <p className="text-xs text-[var(--text-secondary)]">
                {t('automation_testing.panel.intro', 'A test runs this code with an input and checks the result. Tests run the code as it is in the editor, in the closed sandbox; nothing is sent anywhere.')}
            </p>
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={() => runCases()}
                    disabled={cases.length === 0 || run.isPending}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-medium text-[var(--accent-primary-fg)] disabled:opacity-40"
                >
                    {runningId === 'all' ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
                    {t('automation_testing.panel.run_all', 'Run all tests')}
                </button>
                <button
                    type="button"
                    onClick={() => setEditing('new')}
                    disabled={atLimit}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] px-3 py-1.5 text-xs disabled:opacity-40"
                >
                    <Plus size={13} aria-hidden="true" />{t('automation_testing.panel.new', 'New test')}
                </button>
            </div>
            <PanelNotices
                atLimit={atLimit}
                limit={limit}
                summary={summary}
                runFailed={run.isError}
                deleteFailed={remove.isError}
                loading={list.isLoading}
                loadFailed={list.isError}
                empty={cases.length === 0}
            />
            {cases.length > 0 && (
                <ul className="space-y-2">
                    {cases.map((c) => (
                        <CaseRow
                            key={c.id}
                            testCase={c}
                            result={results[c.id]}
                            running={runningId === c.id}
                            busy={run.isPending}
                            onRun={() => runCases([c.id])}
                            onEdit={() => setEditing(c)}
                            onDelete={() => remove.mutate(c.id)}
                        />
                    ))}
                </ul>
            )}
        </div>
    );
}
