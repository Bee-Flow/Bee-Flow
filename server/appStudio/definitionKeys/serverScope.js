// @typecheck strict
'use strict';

/**
 * serverScope: what a formula of a SERVER step can read, beyond the base roots.
 *
 * In the base a server step sees `screen`, `forms` and `actions` as empty: the server trusts no value the
 * browser worked out. `serverScope: 'wide'` is the app's own opt-in: for each server step of a click the
 * browser sends the screen params, the other forms and the action results that step's formulas name, and the
 * server puts them in the scope. They are viewer input, exactly like `form` and `vars` already are: a
 * formula reads them, nothing else does. Who the viewer is, which rows a role may touch and which table or
 * field a step writes never come from them.
 *
 * A flag, not a default of schema version 3: an app that only uses another since-3 addition keeps the scope
 * it had. Absent (every existing app) means today's scope, byte for byte. Not public: the page of an
 * anonymous visitor does not send the wide roots, and neither do a background run or the phone app.
 */

const WIDE = 'wide';

/**
 * @param {unknown} value
 * @param {(code: string, path: string, message: string) => void} push
 */
function canon(value, push) {
    if (value === WIDE) return WIDE;
    push('serverScope.invalid', 'serverScope', 'serverScope takes only "wide" — dropped (leave it out for the standard scope).');
    return undefined;
}

/**
 * @param {unknown} value
 * @param {{ def: Record<string, unknown>, pushE: (finding: Record<string, string>) => void, pushW: (finding: Record<string, string>) => void }} ctx
 */
function validate(value, { def, pushE, pushW }) {
    if (value !== WIDE) {
        pushE({
            code: 'shape.server_scope', severity: 'error', path: 'serverScope',
            message: 'serverScope must be "wide".',
            hint: 'Leave the key out for the standard scope.',
        });
        return;
    }
    // A definition with a publicAccess block has a public page.
    if (def.publicAccess && typeof def.publicAccess === 'object') {
        pushW({
            code: 'server_scope.public_page', severity: 'warning', path: 'serverScope',
            message: 'The public page does not send the wide scope: for an anonymous visitor a server step still reads screen, forms and actions as empty.',
            hint: 'On a public screen, put what a server step needs in a variable first and read vars.<name>.',
        });
    }
}

module.exports = {
    key: 'serverScope',
    since: 3,
    canon,
    validate,
    public: false,
    shape: '"wide"',
    description: 'Lets a server step read screen, forms and actions in its formulas. '
        + 'Without it those three roots are empty on the server, and a formula in a server step (a value, a filter, a guard, an input mapping) that reads screen.params.<name>, forms.<formId>.<field> or actions.<id>.result gives nothing. '
        + 'With "wide" the browser sends them with each server step of a click, so the formula gives on the server what it gives in the browser. '
        + 'They are viewer input like form and vars: never use them as proof of who the viewer is or what they may do (use currentUser and the roles for that). '
        + 'Not sent by a public page, a background action or the phone app: there the three roots stay empty. '
        + 'records, datasets and connectors stay empty on the server either way. '
        + 'No builder tool writes this key yet: ask the app owner to switch it on in the app settings (Theme panel, "Server steps").',
};
