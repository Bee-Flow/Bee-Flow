/**
 * App Studio catalog — node/screen/action ids and the schema version this
 * contract emits. Everything else in componentSpecs/ builds on these two.
 */

'use strict';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const ID_PREFIXES = { screen: 'scr', section: 'sec', component: 'cmp', action: 'act' };
const ID_RE = /^(scr|sec|cmp|act)_[a-z0-9]{4,12}$/;

// ---------------------------------------------------------------------------
// Schema version. This file is the v2 contract; canonicalize accepts any of
// SCHEMA_VERSIONS_ACCEPTED and always emits SCHEMA_VERSION_CURRENT.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION_CURRENT = 2;
const SCHEMA_VERSIONS_ACCEPTED = [1, 2];

function newId(kind) {
    const prefix = ID_PREFIXES[kind] || 'cmp';
    let s = '';
    while (s.length < 6) s += Math.random().toString(36).slice(2);
    return `${prefix}_${s.slice(0, 6)}`;
}

module.exports = {
    ID_PREFIXES,
    ID_RE,
    SCHEMA_VERSION_CURRENT,
    SCHEMA_VERSIONS_ACCEPTED,
    newId,
};
