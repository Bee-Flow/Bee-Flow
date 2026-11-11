// @typecheck strict
/**
 * definition.triggers (schema 3): start an action on the server without anyone at the page.
 *
 *   [{ id, kind, actionId, enabled?, …the fields of its kind }]
 *
 * The kinds: `schedule` (triggers/kinds/schedule.mts), `record` (a changed row of the app,
 * triggers/kinds/record.mts) and `webhook` (a signed call from another system,
 * triggers/kinds/webhook.mts); a kind is one file there. A trigger
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
    shape: '[{ id, kind: "schedule", actionId, schedule: { cron, tz } | { everyMinutes }, enabled? } '
        + '| { id, kind: "record", actionId, tableId, on: ["create" | "update" | "delete"], fields?, when?, allowPublicWrites?, enabled? } '
        + '| { id, kind: "webhook", actionId, auth: "hmac", enabled? }] (max 20)',
    description: 'Triggers start an action on the server by themselves. '
        + 'A trigger runs on a schedule, when a record of the app changes, or when another system calls the trigger\'s address. '
        + 'Nobody is at the page when one runs. '
        + 'The action reads what started it as trigger.kind ("record" or "webhook") and the values of that kind under trigger.<kind>; a schedule run has no trigger root. '
        + 'kind "schedule" runs actionId at set times: schedule.cron is five fields (minute hour day-of-month month day-of-week, '
        + '"0 8 * * 1-5" is weekdays at 08:00) read in schedule.tz, an IANA time zone that is required with a cron; or schedule.everyMinutes for a fixed interval. '
        + 'kind "record" runs actionId when a row of table tableId (a table the app stores itself, not one linked to a Studio table) is created, updated or deleted; on lists the events, '
        + 'fields narrows update to changes of those fields, and when is a formula over trigger.record that must be true. '
        + 'The action reads the change as trigger.record.event, .tableId, .id, .row (for a delete the row as it was), .before, .changed, .by ("member", "owner", "public" or "trigger") and .depth. '
        + 'A record trigger fires on a one-row change a person makes in the app (a grid or form edit, a create_record / update_record / delete_record step by id) and on such a step of another trigger run. '
        + 'It does NOT fire on rows written by the builder tools (app_seed_records, app_update_records, app_run_action, app_run_tests), imports, template installs, connector sync, the mailbox hook, '
        + 'ai_extract, file_intake, a batch create, a transaction step, a replace or upsert, an update_record / delete_record with a filter, or a delete that follows delete rules onto linked records. '
        + 'If visitors of a public page can write the table, a record trigger needs allowPublicWrites: true and its action may then hold no send_email, run_automation, request_approval or delete_record step. '
        + 'Loops end by themselves: a trigger never fires on a row its own run wrote, and a chain of trigger runs stops after 3. Write one with app_set_record_trigger. '
        + 'kind "webhook" runs actionId when another system sends a signed POST with a JSON body to the trigger\'s address: write auth "hmac". '
        + 'The action reads the delivery as trigger.webhook.body (the parsed JSON), trigger.webhook.headers, trigger.webhook.deliveryId and trigger.webhook.receivedAt; '
        + 'the body is untrusted input, so check what you read from it as you would a form, and a webhook action may not hold an http_request step. '
        + 'The address and the signing secret are made when the app is published and shown to the owner in the Triggers panel: they are not part of the app, and you can neither read nor set them. '
        + 'A trigger only runs once the app is PUBLISHED: in a draft it does nothing, and a later change goes live with the next publish. '
        + 'The run is the app owner (role owner, viewer.* is the owner) and has no page, so the action and every action it calls may hold only steps that run unattended: '
        + 'set_variable, condition, switch, loop, while, try, parallel, call_action, return, raise_error, create_record, update_record, delete_record, transaction, '
        + 'dataset_query, ai_generate, ai_extract, kb_query, code, generate_file, fill_document, generate_presentation, redact_pdf, file_intake, '
        + 'send_email (never in a loop), run_automation, request_approval, wait and await_approval (the run goes on hold and continues by itself), '
        + 'and http_request (through a REST connection a person made, with every rule of that step; not in a webhook run). '
        + 'Refused: navigate, open_url, the modal steps, confirm, toast, refresh, reset_form, download_file, every focus/scroll/clipboard/form/ui step, ai_browse, copy_document and the kb_log steps. '
        + 'For an action that a button also runs, keep the page steps in the button\'s action and let it call_action the shared part. '
        + 'Test the action of a record or webhook trigger with app_run_action { scope: { trigger: { kind: "record", record: { event, row, before, changed } } } } (the same shape a real run reads); a test never starts a trigger. '
        + 'A trigger whose runs keep failing is paused and says why in the Triggers panel. enabled: false keeps a trigger in the app without arming it. '
        + 'Write a schedule or webhook trigger with app_set_trigger and take any one out with app_remove_trigger.',
};
