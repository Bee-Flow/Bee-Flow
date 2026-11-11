// @typecheck strict
/**
 * App Studio catalog — the predicates behind the filter forms marked in keys/queryShape/:
 * which groups and clauses a clause list holds. They read a list with the one group grammar
 * (shared/expr/filterGroups.mjs), so a mark and the query compiler agree on what a group is.
 *
 * Total: handed anything that is not a clause list (a formula string, a number, a malformed
 * list) every predicate answers false. The base forms answer false too: a flat list, and a
 * one-level `{ any: [clause, …] }` group.
 *
 * LAYER: pure; the key files under keys/queryShape/ read it.
 */

'use strict';

const { isAllGroup, isNotGroup, isFilterGroup, filterGroupMembers, MAX_FILTER_DEPTH } = require('../../shared/expr/filterGroups.mjs');

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * True when `test(entry, depth)` holds for an entry of the list, at the top level or inside
 * its groups. Groups are opened as deep as the grammar reads them.
 * @param {unknown} filter
 * @param {(entry: unknown, depth: number) => boolean} test  depth: the groups above the entry
 * @returns {boolean}
 */
function someEntry(filter, test) {
    if (!Array.isArray(filter)) return false;
    /** @type {(entry: unknown, depth: number) => boolean} */
    const visit = (entry, depth) => {
        if (test(entry, depth)) return true;
        const members = depth < MAX_FILTER_DEPTH ? filterGroupMembers(entry) : null;
        return members ? members.some((m) => visit(m.node, depth + 1)) : false;
    };
    return filter.some((entry) => visit(entry, 0));
}

/** An `{ all: […] }` group anywhere in the list. @param {unknown} filter */
const usesAllGroup = (filter) => someEntry(filter, (entry) => isAllGroup(entry));

/** A `{ not: … }` group anywhere in the list. @param {unknown} filter */
const usesNotGroup = (filter) => someEntry(filter, (entry) => isNotGroup(entry));

/** A group inside a group. @param {unknown} filter */
const usesNestedGroup = (filter) => someEntry(filter, (entry, depth) => depth > 0 && isFilterGroup(entry));

/** A clause that compares its field with another column of the row. @param {unknown} filter */
const usesOtherField = (filter) => someEntry(filter, (entry) => isObject(entry) && !isFilterGroup(entry) && entry.otherField !== undefined && entry.otherField !== null);

/** A clause whose field is a path through a relation (`<relation>.<field>`). @param {unknown} filter */
const usesRelationField = (filter) => someEntry(filter, (entry) => isObject(entry) && !isFilterGroup(entry) && typeof entry.field === 'string' && entry.field.includes('.'));

module.exports = { usesAllGroup, usesNotGroup, usesNestedGroup, usesOtherField, usesRelationField };
