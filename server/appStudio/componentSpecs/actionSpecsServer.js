// @typecheck strict
'use strict';

/**
 * Additions to the SERVER side of actions (schema version 3): the `guard` a server step may carry and the
 * `formula` kind of a run_automation input mapping. Each is optional, marked `since: 3`, appended at the END
 * of its kind's fields in actionSpecs.js and never written into a definition that does not use it.
 *
 * `guard` sits on every server kind the way `retry` and `onError` do (stepEnvelope.js): one field object,
 * marked `envelope: true`, spread into a new field table per kind, so no base entry is edited and a step's
 * table stays "the action's table plus the envelope".
 */

const GUARD_FIELD = Object.freeze({
    type: 'formula',
    since: 3,
    envelope: true,
    description: 'Skips the step on the server when this formula is false. '
        + 'The server works it out before it runs the step. When it gives false or nothing, or cannot be worked out, the step is skipped: nothing is written or sent, its result is null and the sequence goes on. '
        + 'Use it for a rule the browser must not be able to switch off, for example currentUser.roleKey == "manager" or form.amount <= 500. '
        + 'A condition step decides in the browser, a guard decides on the server. '
        + 'It reads the roots a server step has (form, vars, item, index, value, params, currentUser, now, today), '
        + 'and screen, forms and actions only when the app sets serverScope to "wide". '
        + 'Only currentUser comes from the server: every other root is sent by the browser, so decide who may do something with currentUser, never with vars, form or actions. '
        + 'A guard covers its own step only, so each step that needs the rule carries it. '
        + 'Every server step kind takes it, the kinds added later too. '
        + 'A step inside a transaction takes no guard of its own: put it on the transaction.',
});

/** The kinds of an input mapping added after the base (`static` and `field`): { kind: since }. */
const INPUT_MAPPING_KIND_SINCE = Object.freeze({ formula: 3 });

const INPUT_MAPPING_DOC = 'Per automation input, where its value comes from: {kind:"static",value}, {kind:"field",name,formId?} or, since version 3, '
    + '{kind:"formula",expr}. A formula is worked out on the server when the automation starts, from the roots a server step has '
    + '(form, vars, item, index, value, params, currentUser, now, today), so it can send a variable, the loop item or a computed value. '
    + 'Only on a run_automation STEP of a sequence: a run_automation action on its own takes static and field.';

/**
 * Append the additions, after every other field of a kind exists.
 * @param {Record<string, any>} steps
 */
function extend(steps) {
    for (const spec of Object.values(steps)) {
        if (spec.mutatesData) spec.fields = { ...spec.fields, guard: GUARD_FIELD };
    }
    // The mapping is a map of entries, not an enum: `values` names the kinds of an entry so the mark has
    // something to point at, and the base copy of the field keeps the two base kinds. The STEP only: a
    // bare run_automation action has no server scope to work a formula out in.
    steps.run_automation.fields = {
        ...steps.run_automation.fields,
        inputMapping: {
            ...steps.run_automation.fields.inputMapping,
            values: ['static', 'field', ...Object.keys(INPUT_MAPPING_KIND_SINCE)],
            valuesSince: { ...INPUT_MAPPING_KIND_SINCE },
            description: INPUT_MAPPING_DOC,
        },
    };
}

module.exports = { extend, INPUT_MAPPING_KIND_SINCE };
