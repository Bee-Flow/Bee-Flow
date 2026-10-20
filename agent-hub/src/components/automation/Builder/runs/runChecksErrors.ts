/**
 * The sentences for a refused compare, golden or scenario request. The server
 * answers with a machine code (server/routes/automation/{runCompare,goldens,
 * formScenarios}.js); a person reads a plain sentence that says what to do.
 * Pure; every caller passes its own t().
 */
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { AutomationRequestError } from '../../../../api/queries/automation/http';

const codeOf = (err: unknown): string | null => (err instanceof AutomationRequestError ? err.code : null);
const statusOf = (err: unknown): number | null => (err instanceof AutomationRequestError ? err.status : null);

/** The refusals the three features share: run data that may not be kept or read. */
function shared(code: string | null, t: TranslateFn): string | null {
    switch (code) {
        case 'caller_run_not_capturable':
            return t('automation_run_checks.error.caller_run_not_capturable', 'This run used the connections of the person who started it, so its data cannot be saved as test data.');
        case 'test_data_not_on_prd':
            return t('automation_run_checks.error.test_data_not_on_prd', 'Test data is not kept for automations in a production stage.');
        case 'run_not_finished':
            return t('automation_run_checks.error.run_not_finished', 'This run has not finished yet. Try again when it is done.');
        case 'caller_run_private':
            return t('automation_run_checks.error.caller_run_private', 'This run used the connections of the person who started it, so only they can see its data.');
        case 'run_not_found':
            return t('automation_run_checks.error.run_not_found', 'That run could not be found, or you cannot read its data.');
        default:
            return null;
    }
}

export function compareErrorText(err: unknown, t: TranslateFn): string {
    const code = codeOf(err);
    if (code === 'runs_not_comparable') {
        return t('automation_run_checks.error.runs_not_comparable', 'These two runs belong to different automations, so they cannot be compared.');
    }
    const known = shared(code, t);
    if (known) return known;
    if (statusOf(err) === 403) return t('automation_run_checks.error.compare_forbidden', 'You cannot read the data of one of these runs.');
    return t('automation_run_checks.error.compare_generic', 'Could not compare these runs.');
}

export function goldenErrorText(err: unknown, t: TranslateFn): string {
    const code = codeOf(err);
    switch (code) {
        case 'golden_needs_success':
            return t('automation_run_checks.error.golden_needs_success', 'Only a run that finished successfully can be a golden run.');
        case 'partial_run_not_golden':
            return t('automation_run_checks.error.partial_run_not_golden', 'A run of a single step cannot be a golden run. Pick a run of the whole automation.');
        case 'golden_limit':
            return t('automation_run_checks.error.golden_limit', 'This automation has reached its limit of golden runs. Remove one to add another.');
        case 'replay_in_progress':
            return t('automation_run_checks.error.replay_in_progress', 'A replay is already running. Wait for it to finish.');
        case 'golden_not_found':
            return t('automation_run_checks.error.golden_not_found', 'That golden run no longer exists.');
        default:
    }
    const known = shared(code, t);
    if (known) return known;
    if (statusOf(err) === 429) return t('automation_run_checks.error.rate_limited', 'Too many requests in a short time. Wait a minute and try again.');
    if (statusOf(err) === 403) return t('automation_run_checks.error.golden_forbidden', 'You need edit access to this automation to do that.');
    return t('automation_run_checks.error.golden_generic', 'That did not work. Try again.');
}

export function scenarioErrorText(err: unknown, t: TranslateFn): string {
    const code = codeOf(err);
    switch (code) {
        case 'no_form_answers':
            return t('automation_run_checks.error.no_form_answers', 'This run holds no form answers to save. Pick a run where somebody filled in a form.');
        case 'scenario_name_taken':
            return t('automation_run_checks.error.scenario_name_taken', 'A scenario with this name already exists. Pick another name.');
        case 'scenario_limit':
            return t('automation_run_checks.error.scenario_limit', 'This automation has reached its limit of scenarios. Delete one to save another.');
        case 'scenario_too_large':
            return t('automation_run_checks.error.scenario_too_large', 'The answers of this run are too large to save as a scenario.');
        case 'scenario_not_found':
            return t('automation_run_checks.error.scenario_not_found', 'That scenario no longer exists.');
        case 'invalid_trigger_step':
            return t('automation_run_checks.error.invalid_trigger_step', 'This automation has no form to start from.');
        default:
    }
    const known = shared(code, t);
    if (known) return known;
    if (statusOf(err) === 429) return t('automation_run_checks.error.rate_limited', 'Too many requests in a short time. Wait a minute and try again.');
    if (statusOf(err) === 403) return t('automation_run_checks.error.scenario_forbidden', 'You need edit access to this automation to do that.');
    return t('automation_run_checks.error.scenario_generic', 'That did not work. Try again.');
}

/** Why a golden replay ended in error, from the code the server kept. */
export function replayFailureText(code: string | null, t: TranslateFn): string {
    switch (code) {
        case 'golden_run_gone':
            return t('automation_run_checks.replay_failure.golden_run_gone', 'The saved run no longer exists.');
        case 'trigger_missing':
            return t('automation_run_checks.replay_failure.trigger_missing', 'The automation has no starting point any more.');
        case 'scenario_answers_invalid':
            return t('automation_run_checks.replay_failure.answers_invalid', 'A saved answer no longer fits the form.');
        default:
            return t('automation_run_checks.replay_failure.generic', 'The replay could not run.');
    }
}
