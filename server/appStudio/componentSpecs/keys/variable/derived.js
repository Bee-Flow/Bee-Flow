// @typecheck strict
'use strict';

/** A variable whose value is a formula (shared/appDefinition/variableScopes.mjs). */
module.exports = {
    since: 3,
    shape: '{ expr: "<formula without the {kind} wrapper>" }',
    description: 'Works the value out from a formula each time what it reads changes. '
        + 'expr reads the same scope as a visibleWhen (vars, forms, screen, records, currentUser, today), for example "vars.price * vars.quantity" or "count(records.tbl_orders)". '
        + 'A step that writes it changes nothing, and while the formula gives nothing the default shows. Two derived variables that read each other are an error. '
        + 'A server step works it out again over the server scope and never takes the value the browser sends. Not together with scope or persist. Set it with app_set_variables.',
};
