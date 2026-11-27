// @typecheck strict
/**
 * The pieces every Studio kind of the Adoption report is written with (kinds.js, and the part
 * of each module that declares that module's kinds, stores/adoption/kinds.<module>.js): the
 * shape of a kind and the SQL fragments for its organisation and its audience.
 *
 * A kind declares, for the organisation's view:
 *
 *   objects   one row per object: id, name, owner, created_at, published,
 *             audience ('org' | 'group' | 'private' | 'public'), published_at.
 *             $1 is the organisation. An object belongs to it by its own
 *             organisation column, else by its owner's (older rows of several
 *             kinds carry no organisation; the COALESCE of
 *             automationStore/runsFilter.js, applied to every kind).
 *   evidence  one row per use: object_id, person (null when the evidence has
 *             no person), ts. Joined to the objects, so a use counts for the
 *             organisation exactly when its object does.
 *   personIsOwner  the evidence person is always the object's owner (a
 *             recording, a Cowork run): the drill-down names no owner then.
 *   evidenceSees   the audiences the evidence can observe at all (null: every
 *             audience); "unused" only lists objects it could have seen used.
 */

'use strict';

/**
 * @typedef {{
 *   kind: string,
 *   objects: string,
 *   evidence: ((objects: string) => string) | null,
 *   label: string | null,
 *   peopleKnown: boolean,
 *   itemCost: boolean,
 *   personIsOwner?: boolean,
 *   evidenceSees?: string[],
 * }} KindDef
 */

/**
 * The object's organisation, else its owner's.
 * @param {string} column  the object's organisation column
 */
const inOrg = (column) => `COALESCE(NULLIF(${column}, ''), u."organizationId") = $1`;

/**
 * A JSON array column (TEXT or JSONB) that names at least one group.
 * @param {string} column
 */
const hasGroups = (column) => `COALESCE(NULLIF(${column}::text, ''), '[]') NOT IN ('[]', 'null')`;

/**
 * Who may open it: private until published, then the groups it names or the organisation.
 * @param {string} published
 * @param {string} groups
 */
const audience = (published, groups) => `CASE WHEN NOT COALESCE(${published}, FALSE) THEN 'private'
    WHEN ${hasGroups(groups)} THEN 'group' ELSE 'org' END`;

/**
 * @param {string} select   id, name, owner, created_at, published, audience, published_at
 * @param {string} from     FROM … LEFT JOIN users u … (without WHERE)
 * @param {string} where
 */
const objectsSql = (select, from, where) => `SELECT ${select} ${from} WHERE ${where}`;

module.exports = { inOrg, hasGroups, audience, objectsSql };
