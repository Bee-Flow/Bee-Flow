// @typecheck strict
/**
 * The jobs/webpages side of stores/datatableStore/liveChanges.js: the two
 * consumers that must hear a table's rows moved, registered here so the storage
 * layer does not require a feature.
 *
 *   knowledge-source arm   a `live` source must stop answering from rows that are gone
 *   webpage snapshots      a public share bakes the rows in as static HTML
 *
 * Loaded at boot by boot/featureRegistrations.js. Requires are lazy, so loading
 * this file costs nothing.
 */

'use strict';

const { onDatatableChanged } = require('../stores/datatableStore/liveChanges');

onDatatableChanged(
    (id) => require('./kbSourceRefresh').onDatatableChanged(id),
    'knowledge-source arm',
);
onDatatableChanged(
    (id) => require('../core/webpages/webpageShareReconciler').onDatatableChanged(id),
    'public webpage snapshots',
);
