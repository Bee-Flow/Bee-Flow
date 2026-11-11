// @typecheck strict
'use strict';

/**
 * Fields added to existing action and step kinds for dynamic text and effects (schema version 3). Each is
 * optional, marked `since: 3` and spread at the END of its kind's fields in actionSpecs.js.
 */

const SEQUENCE_EFFECTS = {
        onSuccess: {
            type: 'effects', since: 3,
            description: 'A toast and/or a screen to open after the sequence ends well. Effects are applied once and never chain, so use steps for anything longer. Same shape as on run_automation.',
        },
        onError: {
            type: 'effects', since: 3,
            description: 'A toast and/or a screen to open after the sequence failed. The failure is toasted either way. Effects are applied once and never chain.',
        },
};

const NAVIGATE_EXTRA = {
        screenExpr: {
            type: 'formula', since: 3,
            description: 'A formula that gives the id of the screen to open, instead of screenId. It must return the id of one of this app\'s own screens, any other result stops the sequence with an error. Leave screenId out when you use it.',
        },
};

const TOAST_EXTRA = {
        messageExpr: {
            type: 'formula', since: 3,
            description: 'A formula that gives the message text, instead of message. Build the text with concat, for example concat(\'Saved \', vars.count, \' rows\'). When it returns nothing, message is shown if there is one. Leave message out when you use it.',
        },
};

const OPEN_URL_EXTRA = {
        urlExpr: {
            type: 'formula', since: 3,
            description: 'A formula that gives the web address to open, instead of url. Only https addresses on a host listed in the app\'s allowedLinkHosts open, anything else stops the sequence with an error. Leave url out when you use it.',
        },
};

const CONFIRM_EXTRA = {
        messageExpr: {
            type: 'formula', since: 3,
            description: 'A formula that gives the question text, instead of message. When it returns nothing, message is shown if there is one. Leave message out when you use it.',
        },
        titleExpr: {
            type: 'formula', since: 3,
            description: 'A formula that gives the dialog title, instead of title. When it returns nothing, title is used if there is one.',
        },
        confirmLabelExpr: {
            type: 'formula', since: 3,
            description: 'A formula for the confirm button text, instead of confirmLabel. When it returns nothing, confirmLabel is used if there is one.',
        },
        cancelLabelExpr: {
            type: 'formula', since: 3,
            description: 'A formula for the cancel button text, instead of cancelLabel. When it returns nothing, cancelLabel is used if there is one.',
        },
};

/**
 * Append the fields above to their kinds, after the base tables exist (they land at the END of each kind's
 * fields), and mark the switch case key `whenExpr` (a case is { value, steps } or, since 3, { whenExpr, steps }:
 * the formula picks the case when truthy). The mark is `itemSince`, not `itemShape`: a base field's item shape
 * is part of the frozen pin.
 * @param {Record<string, any>} actions
 * @param {Record<string, any>} steps
 */
function extend(actions, steps) {
    Object.assign(actions.sequence.fields, SEQUENCE_EFFECTS);
    Object.assign(steps.navigate.fields, NAVIGATE_EXTRA);
    Object.assign(steps.toast.fields, TOAST_EXTRA);
    Object.assign(steps.open_url.fields, OPEN_URL_EXTRA);
    Object.assign(steps.confirm.fields, CONFIRM_EXTRA);
    steps.switch.fields.cases.itemSince = { whenExpr: 3 };
}

module.exports = { extend };
