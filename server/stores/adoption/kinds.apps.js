// @typecheck strict
/**
 * The apps module's kind of the Adoption report (stores/adoption/kinds.js asks for it by name):
 * App Studio apps. The shape of a kind is in ./kindSql.js.
 */

'use strict';

const { inOrg, audience, objectsSql } = require('./kindSql');

/** @typedef {import('./kindSql').KindDef} KindDef */

/** @type {KindDef[]} */
const KINDS = [
    {
        kind: 'app',
        objects: objectsSql(
            `o.id, o.name, o.user_id AS owner, o.created_at, o.is_published AS published,
             ${audience('o.is_published', 'o.shared_groups')} AS audience, o.published_at`,
            'FROM studio_apps o LEFT JOIN users u ON u.id = o.user_id',
            inOrg('o.organization_id'),
        ),
        // An action run in the app, by the person who clicked (never a draft or dry run).
        evidence: (objects) => `SELECT r.app_id AS object_id, r.viewer_user_id AS person, r.started_at AS ts
            FROM studio_app_action_runs r JOIN (${objects}) o ON o.id = r.app_id
            WHERE NOT r.dry_run AND NOT r.draft`,
        label: 'action_runs', peopleKnown: true, itemCost: true,
    },
];

module.exports = { KINDS };
