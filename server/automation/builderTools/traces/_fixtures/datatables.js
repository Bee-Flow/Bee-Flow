'use strict';

/**
 * The datatable catalogs the trace fixtures replay against — a fixture's
 * `context.datatables` names one key here, and the replay hands that list to
 * the builder as `draftWrap._datatables` (the "Datatables you may use" block
 * the route attaches on a real turn).
 *
 * A trace was recorded against ONE organisation's real table, whose id means
 * nothing outside it. The replay therefore needs a table with the SAME name
 * and columns as the brief describes — that is what the builder's name→id
 * resolution resolves against — under an id that is deliberately NOT the
 * recorded one: a fixture asserts on this id, which proves the step was
 * bound through the catalog rather than carrying the model's literal
 * ("Facturen") through to a step that would fail closed at run time.
 *
 * Column keys are the lower-case slugs the brief's model wrote in `fields`;
 * names carry the capitals and the dot ("Excl. btw") the user typed, so the
 * catalog exercises the same key/name matching a real table does.
 */
module.exports = {
    facturen: [
        {
            id: 'tbl_facturen_test',
            name: 'Facturen',
            key: 'facturen',
            canWrite: true,
            managedKind: 'nextcloud_table',
            columns: [
                { key: 'datum', name: 'Datum', type: 'date' },
                { key: 'leverancier', name: 'Leverancier', type: 'text' },
                { key: 'factuurnummer', name: 'Factuurnummer', type: 'text' },
                { key: 'excl_btw', name: 'Excl. btw', type: 'number' },
                { key: 'btw', name: 'Btw', type: 'number' },
                { key: 'totaal', name: 'Totaal', type: 'number' },
            ],
        },
    ],
};
