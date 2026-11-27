// @typecheck strict
/**
 * The meeting notes module's kind of the Adoption report (stores/adoption/kinds.js asks for it
 * by name): recorded meetings. The shape of a kind is in ./kindSql.js.
 */

'use strict';

const { inOrg, audience, objectsSql } = require('./kindSql');

/** @typedef {import('./kindSql').KindDef} KindDef */

/** @type {KindDef[]} */
const KINDS = [
    {
        kind: 'meeting',
        objects: objectsSql(
            `o.id, o.title AS name, o.user_id AS owner, o.created_at, COALESCE(o.is_published, FALSE) AS published,
             ${audience('o.is_published', 'o.shared_groups')} AS audience, NULL::timestamptz AS published_at`,
            'FROM transcriptions o LEFT JOIN users u ON u.id = o.user_id',
            inOrg('o.organization_id'),
        ),
        // Recording a meeting is the use: one recording, by the person who made it.
        evidence: (objects) => `SELECT o.id AS object_id, o.owner AS person, o.created_at AS ts FROM (${objects}) o`,
        label: 'recordings', peopleKnown: true, itemCost: false,
        // The use IS the owner's recording: an item names no owner next to it.
        personIsOwner: true,
    },
];

module.exports = { KINDS };
