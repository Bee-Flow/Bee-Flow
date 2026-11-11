// @typecheck strict
/**
 * App Studio — the part of the schema-version walk (schemaVersion.mjs) that reads the FORM of
 * a value inside a data read. Pure, imports nothing.
 *
 * A key a binding newly takes is a plain mark (`bindingKeys` of the since index). A form has no
 * key to mark: a group nested in a filter, a relation path as a clause field, a key of a groupBy
 * entry. Each is a named predicate, and the index holds its `since` under the key the value
 * sits under:
 *
 *   index.queryShapes   { [key]: { [name]: n } }                    filter: { 'filter.nestedGroups': 3 }
 *   tests               { [key]: { [name]: (value) => boolean } }   the predicate of the same name
 *
 * The predicates are functions, so they travel beside the index instead of inside it (the index
 * is marks only). A name without a predicate is never counted as used: whoever builds the index
 * builds the tests from the same marks (appStudio/schemaSince.mts).
 */

/** @typedef {Record<string, Record<string, (value: unknown) => boolean>>} ShapeTests */

/**
 * The highest `since` among the forms the values of `object` have. Own keys only, and a key
 * without a value holds no form.
 * @param {Record<string, unknown>} object
 * @param {Record<string, Record<string, number>>} shapes  index.queryShapes
 * @param {ShapeTests | undefined} tests
 * @returns {number}
 */
export function queryShapeSince(object, shapes, tests) {
    let max = 0;
    if (!tests) return max;
    for (const key of Object.keys(shapes)) {
        if (!Object.prototype.hasOwnProperty.call(object, key) || !Object.prototype.hasOwnProperty.call(tests, key)) continue;
        const value = object[key];
        if (value === undefined || value === null) continue;
        for (const [name, since] of Object.entries(shapes[key])) {
            if (since <= max || !Object.prototype.hasOwnProperty.call(tests[key], name)) continue;
            if (tests[key][name](value) === true) max = since;
        }
    }
    return max;
}
