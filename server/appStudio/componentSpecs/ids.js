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
// Schema version. This file is the v2 contract; canonicalize accepts any of
// SCHEMA_VERSIONS_ACCEPTED and always emits SCHEMA_VERSION_CURRENT.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION_CURRENT = 2;
const SCHEMA_VERSIONS_ACCEPTED = [1, 2];

module.exports = {
    ID_PREFIXES,
    ID_RE,
    SCHEMA_VERSION_CURRENT,
    SCHEMA_VERSIONS_ACCEPTED,
    newId,
};
