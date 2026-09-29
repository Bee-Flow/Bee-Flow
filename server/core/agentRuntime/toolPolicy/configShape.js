/**
 * The SHAPE of a stored `config.tools`: its vocabulary, its bounds, and the two
 * readers everything else in this folder starts from.
 *
 * Nothing here reads the tool registry or decides about a grant — this is only
 * what a config MAY say, so the enumerations and the caps have exactly one home
 * and cannot drift between the reader and the writer.
 */

'use strict';

/** Keys of `config.tools` that are NOT app ids. */
const RESERVED_TOOL_KEYS = Object.freeze(['automations', 'datatables']);
const CONFIRM_MODES = Object.freeze(['direct', 'ask']);
const ACT_AS_MODES = Object.freeze(['viewer', 'owner']);
// Whose rows `datatable_query` may read. 'own' is the narrow one and the
// default for anything unreadable — see normaliseToolsConfig.
const DATATABLE_SCOPES = Object.freeze(['own', 'all']);
// The reserved keys that actually GATE something. Both do, now: `automations`
// narrows which routines are offered, `datatables` narrows which tables
// `datatable_query` will read and what it returns from them. A reserved key
// that enforced NOTHING would have to stay off this list — counting it as a
// curation flips the agent into the confirmation regime on the strength of a
// section that changes nothing about what runs (see hasCuratedGrants).
const GATING_RESERVED_KEYS = Object.freeze(['automations', 'datatables']);

// Bounds. A config is user-supplied JSON that is read on every chat turn; an
// unbounded one is a slow denial of service with extra steps.
const MAX_APP_ENTRIES = 200;
const MAX_ACTIONS_PER_APP = 500;
const MAX_AUTOMATION_GRANTS = 100;
// Lower than the automation bound on purpose: every granted table costs REAL
// database work at assembly time (resolve the table, recompute the grade, read
// the descriptor), where an automation grant costs a map lookup.
const MAX_DATATABLE_GRANTS = 25;
const MAX_COLUMNS_PER_DATATABLE = 200;

// ── Reading a (possibly junk) stored config ─────────────────────────

function _plainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The `tools` map of a config, or null when there is nothing usable there. */
function toolsConfigOf(config) {
    if (!_plainObject(config)) return null;
    return _plainObject(config.tools) ? config.tools : null;
}

/**
 * Keys a plain object cannot safely hold. `out['__proto__'] = {...}` REPLACES
 * the object's prototype instead of adding a key, so a grant keyed on one is
 * silently unreachable — the same reason `queryCompiler.fieldMap` is a Map. No
 * datatable id is ever one of these (they are `tbl_<hex>`), so skipping them
 * costs nothing and keeps the map an ordinary object every reader can iterate.
 */
const UNSAFE_OBJECT_KEYS = Object.freeze(new Set(['__proto__', 'constructor', 'prototype']));

module.exports = {
    RESERVED_TOOL_KEYS, CONFIRM_MODES, ACT_AS_MODES, DATATABLE_SCOPES, GATING_RESERVED_KEYS,
    MAX_APP_ENTRIES, MAX_ACTIONS_PER_APP, MAX_AUTOMATION_GRANTS,
    MAX_DATATABLE_GRANTS, MAX_COLUMNS_PER_DATATABLE,
    UNSAFE_OBJECT_KEYS,
    _plainObject, toolsConfigOf,
};
