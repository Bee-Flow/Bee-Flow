// @typecheck strict
/**
 * App Studio catalog — node/screen/action ids and the schema version this
 * contract emits. Everything else in componentSpecs/ builds on these two.
 */

'use strict';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

// The id helpers are shared with the editor: server/shared/appDefinition/ids.mjs.
const { ID_PREFIXES, ID_RE, newId } = require('../../shared/appDefinition/ids.mjs');

// ---------------------------------------------------------------------------
// Schema version. SCHEMA_VERSION_BASE (2) is what a definition is written
// with unless it uses a catalogue entry marked `since: 3` or higher
// (appStudio/schemaSince.mts); SCHEMA_VERSION_CURRENT is the newest version
// this install reads. canonicalize accepts any of SCHEMA_VERSIONS_ACCEPTED,
// emits the lowest sufficient one, and refuses a version above CURRENT.
// ---------------------------------------------------------------------------

const { SCHEMA_VERSION_BASE, SCHEMA_VERSION_CURRENT } = require('../../shared/appDefinition/schemaVersion.mjs');
const SCHEMA_VERSIONS_ACCEPTED = [1, 2, 3];

module.exports = {
    ID_PREFIXES,
    ID_RE,
    SCHEMA_VERSION_BASE,
    SCHEMA_VERSION_CURRENT,
    SCHEMA_VERSIONS_ACCEPTED,
    newId,
};
