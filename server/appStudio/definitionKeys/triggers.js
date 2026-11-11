// @typecheck strict
/**
 * definition.triggers (schema 3): start an action on the server without anyone at the page.
 *
 *   [{ id, kind, actionId, enabled?, …the fields of its kind }]
 *
 * `schedule` is the first kind (triggers/kinds/schedule.mts); a kind is one file there. A trigger
 * does nothing in a draft: it is armed when the app is PUBLISHED (triggers/triggerSync.mts) and
 * then runs its action as the app owner (triggers/unattendedIdentity.mts), with only the steps
 * that may run unattended (triggers/unattendedPolicy.mts).
 *
 * Never sent to a public page (`public: false`): a visitor has no use for when the server runs what.
 */

'use strict';

/** @returns {typeof import('../triggers/triggerSpec.mts')} */
const spec = () => require('../triggers/triggerSpec.mts');

/**
 * @param {unknown} value
 * @param {(code: string, path: string, message: string) => void} push
 * @param {{ renameMap: unknown, actionIds?: Set<string> }} ctx
 */
function canon(value, push, ctx) {
    return spec().canonTriggers(value, push, ctx);
}

/**
 * @param {unknown} value
 * @param {import('../triggers/triggerSpec.mts').ValidateContext} ctx
 */
function validate(value, ctx) {
    spec().validateTriggers(value, ctx);
}

module.exports = {
    key: 'triggers',
    since: 3,
    public: false,
    canon,
    validate,
    shape: '[{ id, kind: "schedule", actionId, schedule: { cron, tz } | { everyMinutes }, enabled? }] (max 20)',
    description: 'Triggers start an action on the server by themselves, on a schedule. '
        + 'Nobody is at the page when one runs. '
        + 'kind "schedule" runs actionId at set times: schedule.cron is five fields (minute hour day-of-month month day-of-week, '
        + '"0 8 * * 1-5" is weekdays at 08:00) read in schedule.tz, an IANA time zone that is required with a cron; or schedule.everyMinutes for a fixed interval. '
        + 'A trigger only runs once the app is PUBLISHED: in a draft it does nothing, and a later change goes live with the next publish. '
        + 'The run is the app owner (role owner, viewer.* is the owner) and has no page, so the action and every action it calls may hold only steps that run unattended: '
        + 'set_variable, condition, switch, loop, while, try, parallel, call_action, return, raise_error, create_record, update_record, delete_record, transaction, '
        + 'dataset_query, ai_generate, ai_extract, kb_query, code, generate_file, fill_document, generate_presentation, redact_pdf, file_intake, '
        + 'send_email (never in a loop), run_automation, request_approval, wait and await_approval (the run goes on hold and continues by itself), '
        + 'and http_request (through a REST connection a person made, with every rule of that step). '
        + 'Refused: navigate, open_url, the modal steps, confirm, toast, refresh, reset_form, download_file, every focus/scroll/clipboard/form/ui step, ai_browse, copy_document and the kb_log steps. '
        + 'For an action that a button also runs, keep the page steps in the button\'s action and let it call_action the shared part. '
        + 'A trigger whose runs keep failing is paused and says why in the Triggers panel. enabled: false keeps a trigger in the app without arming it. '
        + 'Write one with app_set_trigger and take one out with app_remove_trigger.',
};
