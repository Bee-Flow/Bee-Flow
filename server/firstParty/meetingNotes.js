// @typecheck strict
/**
 * Composition of the first-party module "meetingNotes" (Meeting notes): meeting notes:
 * transcription, summaries, voiceprints and the Talk, Meet and Teams settings.
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
    id: 'meetingNotes',
    requires: [],
    uses: ['automation', 'compliance', 'int_nextcloud', 'int_google', 'int_microsoft', 'projects'],
});
