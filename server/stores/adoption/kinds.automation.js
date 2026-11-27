// @typecheck strict
/**
 * The automation module's kinds of the Adoption report (stores/adoption/kinds.js asks for them
 * by name): automations and their forms. The shape of a kind is in ./kindSql.js.
 */

'use strict';

const { inOrg, audience, objectsSql } = require('./kindSql');

/** @typedef {import('./kindSql').KindDef} KindDef */

/** A live run of an automation, not a test run. */
const LIVE_RUN = `r.mode = 'live' AND NOT COALESCE(r.is_test, FALSE)`;

/** @type {KindDef[]} */
const KINDS = [
    {
        kind: 'automation',
        objects: objectsSql(
            `o.id, o.title AS name, o.user_id AS owner, o.created_at, COALESCE(o.is_published, FALSE) AS published,
             ${audience('o.is_published', 'o.shared_groups')} AS audience, o.live_at AS published_at`,
            'FROM automations o LEFT JOIN users u ON u.id = o.user_id',
            `${inOrg('o.organization_id')} AND o.kind = 'automation' AND o.deleted_at IS NULL`,
        ),
        // A live run, counted for whoever started or submitted it, the owner
        // only for a run nobody started (a schedule, a webhook).
        evidence: (objects) => `SELECT r.automation_id AS object_id,
                COALESCE(r.started_by_user_id, r.submitted_by_user_id, r.user_id) AS person,
                COALESCE(r.started_at, r.created_at) AS ts
            FROM automation_runs r JOIN (${objects}) o ON o.id = r.automation_id WHERE ${LIVE_RUN}`,
        label: 'runs', peopleKnown: true, itemCost: true,
    },
    {
        kind: 'form',
        // One row per automation with a form page (the busiest automation is
        // still one form); the item id is the automation's, which its runs carry.
        objects: `SELECT DISTINCT ON (o.id) o.id, o.title AS name, o.user_id AS owner, p.created_at,
                (o.is_active AND NOT o.is_draft) AS published,
                CASE WHEN p.audience = 'restricted' THEN 'group' ELSE 'org' END AS audience, o.live_at AS published_at
            FROM automation_form_pages p JOIN automations o ON o.id = p.automation_id LEFT JOIN users u ON u.id = o.user_id
            WHERE ${inOrg('o.organization_id')} AND o.deleted_at IS NULL AND p.is_test = FALSE
            ORDER BY o.id, p.created_at`,
        evidence: (objects) => `SELECT r.automation_id AS object_id, r.submitted_by_user_id AS person,
                COALESCE(r.started_at, r.created_at) AS ts
            FROM automation_runs r JOIN (${objects}) o ON o.id = r.automation_id
            WHERE r.trigger_kind = 'form' AND ${LIVE_RUN}`,
        label: 'submissions', peopleKnown: true, itemCost: false,
    },
];

module.exports = { KINDS };
