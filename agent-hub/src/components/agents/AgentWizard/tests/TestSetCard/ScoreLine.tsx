import { PROGRESS, RUN_STATE, justRanScore } from '../testSetFacts';
import type { ScoreLineProps } from '../TestSetCard.types';

export function ScoreLine({ t, summary, questionCount, progress }: ScoreLineProps) {
    // A running run has no result. What is there is progress, and it must read that way too:
    // not as an interim tally that claims "3 passed".
    if (progress && progress.status === PROGRESS.RUNNING) {
        return (
            <div data-testid="agent-tests-score" data-state="running" className="text-[15px] font-semibold text-[var(--text-primary)]">
                {progress.total === null
                    ? t('agent_studio.test.running', 'Running…')
                    : t('agent_studio.test.running_n', 'Running… {done} of {total}', { done: progress.done, total: progress.total })}
            </div>
        );
    }
    if (progress && progress.status === PROGRESS.UNFINISHED) {
        return (
            <div data-testid="agent-tests-score" data-state="unfinished" className="text-[13px] text-[var(--text-secondary)]">
                {t('agent_studio.test.run_unfinished', 'That run did not finish, so it is not a result.')}
            </div>
        );
    }
    const justRan = justRanScore(progress);
    if (justRan) {
        return (
            <div data-testid="agent-tests-score" data-state="result" data-kept={justRan.kept ? 'yes' : 'no'}
                className="text-[15px] font-semibold text-[var(--text-primary)]">
                {t('agent_studio.test.score', '{passed} of {total} passed',
                    { passed: justRan.passed, total: justRan.total })}
            </div>
        );
    }
    switch (summary.state) {
        case RUN_STATE.RESULT:
            return (
                <div data-testid="agent-tests-score" data-state="result" className="text-[15px] font-semibold text-[var(--text-primary)]">
                    {t('agent_studio.test.score', '{passed} of {total} passed', { passed: summary.passed, total: summary.total })}
                </div>
            );
        case RUN_STATE.UNKNOWN:
            return (
                <div data-testid="agent-tests-score" data-state="unknown" className="text-[13px] text-[var(--warning)]">
                    {t('agent_studio.test.last_run_unknown', 'Could not read the last run, so nothing is claimed here.')}
                </div>
            );
        case RUN_STATE.UNFINISHED:
            return (
                <div data-testid="agent-tests-score" data-state="unfinished" className="text-[13px] text-[var(--warning)]">
                    {t('agent_studio.test.stored_unfinished', 'The last run did not finish, so there is no score for it.')}
                </div>
            );
        default:
            return (
                <div data-testid="agent-tests-score" data-state="never" className="text-[15px] font-semibold text-[var(--text-primary)]">
                    {questionCount === 0
                        ? t('agent_studio.test.no_questions', 'No questions yet')
                        : t('agent_studio.test.never_run', 'Not run yet')}
                </div>
            );
    }
}
