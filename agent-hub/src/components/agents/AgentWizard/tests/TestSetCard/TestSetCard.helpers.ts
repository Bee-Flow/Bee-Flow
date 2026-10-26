import { REFUSAL, type AgentTest, type Refusal } from '../testSetFacts';
import type { TranslateFn } from '@/hooks/useTranslation';

/**
 * The sentence for one problem.
 *
 * Purely based on `kind` from `problemFor`, so the closed values of the server
 * (`decidedBy`) and the FACTS (a forbidden word that is literally present, a tool that was
 * never called) each get their own translatable rule. The English sentence that the server
 * stored is not shown: it is not translated and says the same thing.
 */
export function problemSentence(t: TranslateFn, problem: { status: string; kind: string; names: string[]; reason: string } | null) {
    if (!problem) return '';
    const names = (problem.names || []).join(', ');
    switch (problem.kind) {
        case 'forbidden':
            return t('agent_studio.test.fail_forbidden', 'Said something this test forbids: {names}', { names });
        case 'tools_missing':
            return t('agent_studio.test.fail_tools_missing', 'Did not use: {names}', { names });
        case 'withheld':
            return names
                ? t('agent_studio.test.blocked_withheld', 'A test run never uses {names}, so this could not be checked.', { names })
                : t('agent_studio.test.blocked_plain', 'This expectation cannot be checked in a test run.');
        case 'ungraded':
            return t('agent_studio.test.errored', 'There was no answer to grade, so this says nothing about the agent.');
        case 'decided:must_mention':
            return t('agent_studio.test.fail_must_mention', 'Did not get across everything this test asks for.');
        case 'decided:must_not_mention':
            return t('agent_studio.test.fail_must_not_mention', 'Said something this test forbids.');
        case 'decided:tools':
            return t('agent_studio.test.fail_tools', 'Did not use the tools this test expects.');
        case 'decided:rules':
            return t('agent_studio.test.fail_rules', 'Did not follow the rules this test expects.');
        case 'decided:notes':
            return t('agent_studio.test.fail_notes', 'Did not meet the extra note on this test.');
        default:
            return t('agent_studio.test.fail_overall', 'Not a usable answer to the question.');
    }
}

/** De zin bij een weigering. Elke soort zegt óók dat er niets getest is. */
export function refusalSentence(t: TranslateFn, refusal: Refusal) {
    switch (refusal.kind) {
        case REFUSAL.NO_GRADER:
            return t('agent_studio.test.refused_no_grader', 'No AI model is set up to grade these answers, so nothing was tested.');
        case REFUSAL.NO_SUGGESTER:
            return t('agent_studio.test.refused_no_suggester', 'No AI model is set up to write this suggestion.');
        case REFUSAL.MODEL_UNREADABLE:
            return t('agent_studio.test.refused_model_unreadable', 'Could not look up which model does this, so nothing ran.');
        case REFUSAL.SUGGESTION_UNREADABLE:
            return t('agent_studio.test.refused_suggestion', 'Could not write a suggestion for this answer.');
        case REFUSAL.LIMIT:
            return t('agent_studio.test.refused_limit', 'Your plan has no room for a test run right now, so nothing was tested.');
        case REFUSAL.CHECK_FAILED:
            return t('agent_studio.test.refused_check', 'Could not check your workspace or your plan, so nothing ran.');
        case REFUSAL.NOTHING_TO_RUN:
            return t('agent_studio.test.refused_empty', 'There is nothing to run yet — write a question first.');
        case REFUSAL.NOT_EDITABLE:
            // What is true: this agent keeps tests, and you may not see them.
            // The old sentence ("You can look at these tests, but not run them")
            // promised precisely the read that the server refuses.
            return t('agent_studio.test.refused_not_editable', 'You need edit access to this agent to see and run its tests.');
        case REFUSAL.TOO_MANY:
            return t('agent_studio.test.refused_too_many', 'This agent already holds as many tests as it can.');
        case REFUSAL.NOT_SAVED:
            return t('agent_studio.test.refused_not_saved', 'The tests ran, but the result could not be saved — so this score is not kept.');
        case REFUSAL.RUN_STOPPED:
            // "Nothing was tested" would be false here: the results that already came in
            // are shown beneath it on the screen.
            return t('agent_studio.test.refused_run_stopped', 'The run stopped part-way. What you see below is what had already been tested.');
        default:
            // Unknown narrows: we do not know HOW FAR it got, so we also do not claim that
            // nothing was tested.
            return t('agent_studio.test.refused_unknown', 'Could not finish the test run.');
    }
}

/**
 * Did a MODEL write part of this expectation?
 *
 * `writtenBy` comes from the storage (agent_tests.written_by) and is null for every test
 * that someone typed himself. Without this marker, an expectation written by a model was
 * no longer distinguishable after saving from a typed one, while every run result that
 * follows from it relies on it.
 */
export function aiWrote(test: AgentTest) {
    const by = test && test.writtenBy;
    if (!by || typeof by !== 'object') return false;
    return Object.values(by).some(v => v === 'ai');
}
