// @typecheck strict
/**
 * The webpages module's kind of the Adoption report (stores/adoption/kinds.js asks for it by
 * name). The shape of a kind is in ./kindSql.js.
 */

'use strict';

const { inOrg, audience, objectsSql } = require('./kindSql');

/** @typedef {import('./kindSql').KindDef} KindDef */

/** The live public shares of webpage `o`. */
const PUBLIC_WEBPAGE = `EXISTS (SELECT 1 FROM webpage_public_shares s WHERE s.webpage_id = o.id
    AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > NOW()))`;

/** @type {KindDef[]} */
const KINDS = [
    {
        kind: 'webpage',
        objects: objectsSql(
            `o.id, o.name, o.user_id AS owner, o.created_at, (COALESCE(o.is_published, FALSE) OR ${PUBLIC_WEBPAGE}) AS published,
             CASE WHEN ${PUBLIC_WEBPAGE} THEN 'public' ELSE ${audience('o.is_published', 'o.shared_groups')} END AS audience,
             NULL::timestamptz AS published_at`,
            'FROM webpages o LEFT JOIN users u ON u.id = o.user_id',
            inOrg('o.organization_id'),
        ),
        // Views of a public share: the only visits recorded (the people inside
        // the organisation are not tracked, so `people` stays unknown).
        evidence: (objects) => `SELECT s.webpage_id AS object_id, NULL::text AS person, v.viewed_at AS ts
            FROM webpage_public_share_views v JOIN webpage_public_shares s ON s.id = v.share_id
            JOIN (${objects}) o ON o.id = s.webpage_id`,
        label: 'public_views', peopleKnown: false, itemCost: false,
        // Only a page with a public share can show a use: the drill-down's
        // "published but unused" lists those, not a page published inside.
        evidenceSees: ['public'],
    },
];

module.exports = { KINDS };
