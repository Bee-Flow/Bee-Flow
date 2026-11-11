// @typecheck strict
'use strict';

/** A variable that belongs to the screen the viewer is on (shared/appDefinition/variableScopes.mjs). */
module.exports = {
    since: 3,
    shape: '"screen" (leave out for a value the whole app shares)',
    description: 'Makes the variable start from its default each time a screen is opened. '
        + 'Leaving a screen forgets the value, so a search box or a selected tab of one screen is not still set on the next. '
        + 'It is read and written as vars.<name> like any variable. Not together with persist or derived. Set it with app_set_variables.',
};
