// @typecheck strict
/**
 * The registrations of the first-party module "datatables": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * It provides no names of the three lookup registries, so it has no provides file.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

function register() {
    contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({
        // what the core asks of this module by name (optionalFeatureModule): one getter per line
        'stores/datatableStore': () => require('../stores/datatableStore'),
        'stores/datatableDbStore': () => require('../stores/datatableDbStore'),
        'auth/datatableAccess': () => require('../auth/datatableAccess'),
        'core/tools/datatableTools': () => require('../core/tools/datatableTools'),
        'core/kb/sources/datatable': () => require('../core/kb/sources/datatable'),
        'core/dataEngine/sources/spreadsheetFile/linkerAuth': () => require('../core/dataEngine/sources/spreadsheetFile/linkerAuth'),
        'core/dataEngine/sources/spreadsheetFile/providers/index': () => require('../core/dataEngine/sources/spreadsheetFile/providers/index'),
        'core/dataEngine/sources/spreadsheetFile/providers/documents': () => require('../core/dataEngine/sources/spreadsheetFile/providers/documents'),
        'core/dataEngine/sources/spreadsheetFile/linkBrowse': () => require('../core/dataEngine/sources/spreadsheetFile/linkBrowse'),
        'core/dataEngine/sources/spreadsheetFile/linkRelink': () => require('../core/dataEngine/sources/spreadsheetFile/linkRelink'),
        'core/automationRunner/datatableResolve': () => require('../core/automationRunner/datatableResolve'),
        'core/dataEngine/datatableRuntime': () => require('../core/dataEngine/datatableRuntime'),
        'core/dataEngine/provisionManagedTable': () => require('../core/dataEngine/provisionManagedTable'),
        'core/dataEngine/dataModel/managedTables': () => require('../core/dataEngine/dataModel/managedTables'),
        'core/dataEngine/datatableLimits': () => require('../core/dataEngine/datatableLimits'),
        'core/dataEngine/sources/spreadsheetFile/formats/index': () => require('../core/dataEngine/sources/spreadsheetFile/formats/index'),
        'core/dataEngine/sources/spreadsheetFile/formats/csv': () => require('../core/dataEngine/sources/spreadsheetFile/formats/csv'),
        'core/dataEngine/sources/spreadsheetFile/formats/sheetjs': () => require('../core/dataEngine/sources/spreadsheetFile/formats/sheetjs'),
        'core/dataEngine/sources/spreadsheetFile/cells': () => require('../core/dataEngine/sources/spreadsheetFile/cells'),
    }));
    // The live-datatable listeners (stores/datatableStore/liveChanges.js, this module's): the
    // knowledge-source arm, public webpage snapshots and the cowork items that start on a table.
    contribute('boot/featureRegistrations', () => require('../jobs/datatableChangePorts'));
}

module.exports = { register };
