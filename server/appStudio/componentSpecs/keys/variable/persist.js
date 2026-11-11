// @typecheck strict
'use strict';

/** A variable the browser keeps for the same viewer (shared/appDefinition/variableScopes.mjs). */
module.exports = {
    since: 3,
    shape: '"session" | "local"',
    description: 'Keeps the value in the browser for the same signed-in viewer of this app. '
        + '"session" keeps it until the browser tab closes, "local" until the browser data is cleared, so a reload starts where the viewer was. '
        + 'Only for a signed-in viewer of the live app: an anonymous visitor of a public page, the editor and the server always start from the default. '
        + 'All kept values of one app share 16 KB; a larger value is not kept. The value stays on that device, so never keep personal data or anything secret in it. '
        + 'Not together with scope "screen" or derived. Set it with app_set_variables.',
};
