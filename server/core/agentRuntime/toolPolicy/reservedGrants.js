/**
 * The grants that are NOT keyed on an app — the `RESERVED_TOOL_KEYS`, on the
 * READ side: which routines an agent is offered and whether they ask first,
 * and which datatables `datatable_query` may read, whose rows and which
 * columns.
 *
 * Every reader here repeats the normalisation rather than trusting it: a row
 * written before the rule existed, or by a client that skipped the route, must
 * not reach dispatch with a scope nobody clamped.
 */

'use strict';

const {
    _plainObject, toolsConfigOf, CONFIRM_MODES, DATATABLE_SCOPES,
    MAX_DATATABLE_GRANTS, MAX_COLUMNS_PER_DATATABLE, UNSAFE_OBJECT_KEYS,
} = require('./configShape');

/**
 * The granted automations as `{ id: { confirm } }` (empty object when none).
 *
 * Read by `getIntegrationTools`, which narrows the caller-keyed routine set to
 * these ids, and by `automationConfirmsFor` for the per-routine confirm.
 */
function automationGrantsOf(toolsConfig) {
    if (!toolsConfig || !_plainObject(toolsConfig.automations)) return {};
    return toolsConfig.automations;
}

/**
 * The granted datatables as `{ id: { scope, columns } }` (empty when none).
 *
 * The READ side of the section `normaliseToolsConfig` writes, and it repeats
 * that normalisation rather than trusting it. Both ends, for the same reason
 * the module header gives for `tools` as a whole: a row written before this
 * rule existed — or by a client that skipped the route — must not reach
 * `datatable_query` with a scope nobody clamped.
 *
 * Every unreadable half lands on the NARROW side, and the two halves narrow
 * differently because they answer different questions:
 *
 *   `scope`    is an ACCESS question — whose rows. Unknown ⇒ `'own'`, so a
 *              typo ('everything', 'ALL', true) reads the agent's owner down
 *              to the asker's own rows rather than up to everybody's.
 *   `columns`  is a PROJECTION question — how much of a table the owner
 *              already picked. Absent or `'*'` ⇒ every declared column, which
 *              is what picking the table plainly meant. A value nobody can
 *              read is NOT that: it becomes `[]` (no columns), the same
 *              refusal `actions` makes, and `datatable_query` then refuses the
 *              table out loud instead of quietly serving all of it.
 *
 * Never throws — it is read inside a chat turn, and an exception there takes
 * the turn down. An unreadable section is an empty one.
 */
function datatableGrantsOf(toolsConfig) {
    const out = {};
    try {
        if (!toolsConfig || !_plainObject(toolsConfig.datatables)) return out;
        for (const [id, raw] of Object.entries(toolsConfig.datatables).slice(0, MAX_DATATABLE_GRANTS)) {
            if (typeof id !== 'string' || !id || UNSAFE_OBJECT_KEYS.has(id)) continue;
            if (!_plainObject(raw)) {
                // NOT `{}`. An absent `columns` means "every declared column",
                // so reading a grant nobody can parse as an empty object would
                // hand the whole table over — the widest possible answer to
                // the least readable input, and the exact shape the normaliser
                // narrows to `columns: []`. The two ends have to agree, or the
                // read side quietly undoes the write side.
                out[id] = { scope: 'own', columns: [] };
                continue;
            }
            const scope = DATATABLE_SCOPES.includes(raw.scope) ? raw.scope : 'own';
            out[id] = { scope, columns: _datatableColumns(raw.columns) };
        }
    } catch (_) { /* an unreadable section grants nothing */ }
    return out;
}

/** `'*'` (every declared column) or the picked list. See datatableGrantsOf. */
function _datatableColumns(raw) {
    if (raw === undefined || raw === null || raw === '*') return '*';
    if (!Array.isArray(raw)) return [];      // unreadable ⇒ nothing granted
    const seen = new Set();
    const out = [];
    for (const c of raw) {
        if (typeof c !== 'string' || !c || seen.has(c)) continue;
        seen.add(c);
        out.push(c);
        if (out.length >= MAX_COLUMNS_PER_DATATABLE) break;
    }
    return out;
}

/**
 * `toolName → 'direct'|'ask'` for the granted routines whose grant carries a
 * `confirm`. Empty Map when the agent curates no automations, so passing this
 * everywhere costs an uncurated agent nothing.
 *
 * A routine's tool name is per-user and built at assembly time
 * (`automation_<id>`, or the author's own `toolName`), so the grant — which is
 * keyed on the automation ID — can only be matched against the ASSEMBLED
 * stack. That is why this takes `tools` and not just a config: without the
 * definitions in hand, `automations[].confirm` has nothing to attach to, which
 * is exactly how it came to be stored and never enforced.
 */
function automationConfirmsFor(tools, agentConfig) {
    const out = new Map();
    const grants = automationGrantsOf(toolsConfigOf(agentConfig));
    if (Object.keys(grants).length === 0) return out;
    for (const t of tools || []) {
        const id = t && t.__automation && t.__automation.id;
        const name = t && t.function && t.function.name;
        if (!id || typeof name !== 'string' || !name) continue;
        const g = grants[id];
        if (_plainObject(g) && CONFIRM_MODES.includes(g.confirm)) out.set(name, g.confirm);
    }
    return out;
}

module.exports = {
    automationGrantsOf, automationConfirmsFor, datatableGrantsOf,
    _datatableColumns,
};
