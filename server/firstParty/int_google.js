// @typecheck strict
/**
 * Composition of the first-party module "int_google" (Google Workspace tools): the Google
 * Workspace tool families (Gmail, Calendar, Contacts, Drive, Keep).
 *
 * What this module adds to the server's composition (mounts, registrations, startup jobs,
 * shutdown, stores, migrations) is in the part files beside this one, merged by withParts
 * (modules/firstParty/parts.js, contract in modules/firstParty/contract.js). The loader
 * (modules/firstParty/loader.js) finds this file through the tree; nothing requires it by
 * path. requires and uses are those of scripts/module-map.json (held equal by
 * modules/firstParty/compositions.test.js).
 */

'use strict';

const { withParts } = require('../modules/firstParty/parts');

module.exports = withParts({
    id: 'int_google',
    requires: [],
    uses: ['automation', 'cowork', 'meetingNotes', 'int_microsoft'],
    // The capabilities it offers (core/entitlements/capabilityRegistry.js ids); they leave the projection while it is absent.
    capabilities: [
        'gmail', 'google-calendar', 'google-drive', 'google-slides', 'google-sheets', 'google-docs',
        'google-contacts', 'google-keep', 'google-groups', 'maps',
    ],
});
