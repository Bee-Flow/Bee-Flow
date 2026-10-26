// What one test run of one case found: the expectation, every check in plain
// words, and the result, log and "would have called" the same way "Try it"
// shows them.
import { CheckCircle2, XCircle } from 'lucide-react';
import type { Assertion, TestCase, TestRunResult } from '@/api/queries/automation/testCases';
import { useTranslation } from '@/hooks/useTranslation';
import { assertionSentence, failureSentence, reasonSentence } from './assertionText';
import { Result } from './CodeTryPanel';

interface TestCaseResultProps {
    result: TestRunResult;
    /** The case, so a passed check can be worded from its definition. */
    testCase?: TestCase | null;
}

export default function TestCaseResult({ result, testCase = null }: TestCaseResultProps) {
    const { t } = useTranslation();
    const byId = new Map<string, Assertion>((testCase?.assertions || []).map((a) => [a.id, a]));
    const outcome = (v: 'success' | 'error' | null): string => (v === 'error'
        ? t('automation_testing.outcome.error', 'it failed with an error')
        : v === 'success' ? t('automation_testing.outcome.success', 'it succeeded') : t('automation_testing.outcome.none', 'it did not run'));

    if (result.reason) {
        return (
            <div className="space-y-1 text-xs" data-testid="test-case-result">
                <p className="text-[var(--text-secondary)]">{reasonSentence(t, result.reason, result.error)}</p>
            </div>
        );
    }
    return (
        <div className="space-y-2 text-xs" data-testid="test-case-result">
            <p className="text-[var(--text-secondary)]">
                {t('automation_testing.result.expectation', 'Expected: {expected}. Got: {got}.', {
                    expected: outcome(result.expectation.expected),
                    got: outcome(result.expectation.got),
                })}
            </p>
            {result.assertions.length > 0 && (
                <ul className="space-y-1">
                    {result.assertions.map((r) => {
                        const a = byId.get(r.id);
                        const Icon = r.ok ? CheckCircle2 : XCircle;
                        return (
                            <li key={r.id} className={`flex items-start gap-1.5 ${r.ok ? 'text-[var(--text-secondary)]' : 'text-[var(--error)]'}`}>
                                <Icon size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                                <span>{r.ok
                                    ? (a ? assertionSentence(t, a) : t('automation_testing.result.check_ok', 'Check passed'))
                                    : failureSentence(t, r, a)}</span>
                            </li>
                        );
                    })}
                </ul>
            )}
            <Result r={{ ok: !result.error, result: result.result, logs: result.logs, calls: result.calls, durationMs: result.durationMs, error: result.error }} />
        </div>
    );
}
