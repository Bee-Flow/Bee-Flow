// @typecheck strict
/**
 * App Studio catalog — the screen keys of the client triggers (schema 3): `screen.events`
 * and `screen.timers`. Kept out of screenSpec.js so their text can say how to use them
 * without crowding the base table; SCREEN_SPEC lists them at its end.
 *
 * The shapes and bounds are in shared/appDefinition/clientTriggers.mjs. The canonicalizer
 * (canonicalize/clientTriggers.js) cleans them and leaves an absent key absent, the
 * validator (validate/clientTriggerChecks.mts) checks the references, the run gate and the
 * public surface count the actions they name, and only a live run fires them.
 */

'use strict';

const { CLIENT_TRIGGER_LIMITS: L } = require('../../shared/appDefinition/clientTriggers.mjs');

const SCREEN_TRIGGER_KEYS = Object.freeze({
    events: Object.freeze({
        type: 'object',
        since: 3,
        description: 'Screen events: onOpen runs actions each time the screen opens. '
            + 'Shape { onOpen: "act_x" }, or a list of up to '
            + `${L.MAX_ACTIONS_PER_EVENT} action ids { onOpen: ["act_a", "act_b"] } that run one after the other and stop at the first that fails. `
            + 'It fires in the live app only (also after a navigate to this screen with other params), never in the editor or a screenshot. '
            + 'Use it to prepare the screen: set_variable to reset a filter, a refresh step, a dataset query into a resultVar. '
            + 'Do not use it for something a binding already loads by itself. On a public page it runs only actions of the public screens. '
            + 'Write it with app_update_screen { screenId, events: { onOpen: "act_…" } }, and events: null removes it. '
            + 'The same list form works on every component event slot (onClick, onSubmit, onChange, …) through app_bind_action.',
    }),
    timers: Object.freeze({
        type: 'list',
        since: 3,
        maxItems: L.MAX_SCREEN_TIMERS,
        itemShape: Object.freeze({
            id: Object.freeze({ type: 'string', required: true }),
            everySeconds: Object.freeze({ type: 'int', required: true }),
            actionId: Object.freeze({ type: 'string', required: true }),
        }),
        description: 'Timers that run an action every few seconds while the screen is open. '
            + `everySeconds is ${L.MIN_TIMER_SECONDS} to ${L.MAX_TIMER_SECONDS}, at most ${L.MAX_SCREEN_TIMERS} timers per screen, id is a short name (letters, digits, _ or -). `
            + 'A timer pauses while the browser tab is hidden and skips a tick while its previous run is still busy. '
            + 'It never runs in the editor or a screenshot. Only to reload the data on screen, use the screen\'s refreshInterval instead: '
            + 'a timer is for running an action, such as a check that writes a variable or a step that advances a status. '
            + 'Write the complete list with app_update_screen { screenId, timers: [{ id: "poll", everySeconds: 30, actionId: "act_…" }] }, and timers: null removes them.',
    }),
});

module.exports = { SCREEN_TRIGGER_KEYS };
