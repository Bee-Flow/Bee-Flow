// @typecheck strict
/**
 * The cowork module's kind of the Adoption report (stores/adoption/kinds.js asks for it by
 * name): Cowork jobs and their runs. The shape of a kind is in ./kindSql.js.
 */

'use strict';

const { objectsSql } = require('./kindSql');

/** @typedef {import('./kindSql').KindDef} KindDef */

/** @type {KindDef[]} */
const KINDS = [
    {
        kind: 'cowork',
        // Cowork jobs carry no organisation: they are their owner's.
        objects: objectsSql(
            `o.id, o.title AS name, o.user_id AS owner, o.created_at, FALSE AS published,
             'private' AS audience, NULL::timestamptz AS published_at`,
            'FROM cowork_schedules o JOIN users u ON u.id = o.user_id',
            'u."organizationId" = $1',
        ),
        evidence: (objects) => `SELECT r.schedule_id AS object_id, r.user_id AS person, r.started_at AS ts
            FROM cowork_runs r JOIN (${objects}) o ON o.id = r.schedule_id`,
        label: 'cowork_runs', peopleKnown: true, itemCost: false,
        // A Cowork job runs for its owner only: the runs are the owner's own.
        personIsOwner: true,
    },
];

module.exports = { KINDS };
