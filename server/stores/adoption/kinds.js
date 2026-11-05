// @typecheck strict
/**
 * The Studio kinds of the Adoption report, organisation-wide: for each kind,
 * the SQL of its objects and, where one exists, the SQL of its usage evidence.
 *
 * routes/studio/counts.js counts per CALLER, through the list functions of
 * each kind, on purpose. This table is the organisation's view instead, and
 * reads every table directly:
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
 *
 * Kinds without a usage signal (datatables, knowledge bases, documents,
 * playbooks) have no evidence: the report says "no signal" rather than
 * inventing one, and nothing here records views (docs/docs/reference/telemetry.md).
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

/** The live public shares of webpage `o`. */
const PUBLIC_WEBPAGE = `EXISTS (SELECT 1 FROM webpage_public_shares s WHERE s.webpage_id = o.id
    AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > NOW()))`;

/** A live run of an automation, not a test run. */
const LIVE_RUN = `r.mode = 'live' AND NOT COALESCE(r.is_test, FALSE)`;

/**
 * @param {string} select   id, name, owner, created_at, published, audience, published_at
 * @param {string} from     FROM … LEFT JOIN users u … (without WHERE)
 * @param {string} where
 */
const objectsSql = (select, from, where) => `SELECT ${select} ${from} WHERE ${where}`;

/** @type {KindDef[]} */
const KINDS = [
    {
        kind: 'agent',
        objects: objectsSql(
            `o.id, o.name, o.owner_id AS owner, o.created_at, COALESCE(o.is_published, FALSE) AS published,
             ${audience('o.is_published', 'o.shared_groups')} AS audience, o.published_at`,
            'FROM agents o LEFT JOIN users u ON u.id = o.owner_id',
            `${inOrg('o.organization_id')} AND o.owner_id NOT IN ('system', 'swarm')`,
        ),
        // A conversation with the agent that was active in the period.
        evidence: (objects) => `SELECT c.agent_id AS object_id, c.user_id AS person, c.updated_at AS ts
            FROM agent_conversations c JOIN (${objects}) o ON o.id = c.agent_id`,
        label: 'conversations', peopleKnown: true, itemCost: true,
    },
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
    {
        kind: 'datatable',
        objects: objectsSql(
            `o.id, o.name, o.owner_user_id AS owner, o.created_at, o.is_published AS published,
             ${audience('o.is_published', 'o.shared_groups')} AS audience, NULL::timestamptz AS published_at`,
            'FROM datatables o LEFT JOIN users u ON u.id = o.owner_user_id',
            inOrg('o.organization_id'),
        ),
        evidence: null, label: null, peopleKnown: false, itemCost: false,
    },
    {
        kind: 'kb',
        objects: objectsSql(
            `o.id::text AS id, o.name, o.tenant_id AS owner, o.created_at, COALESCE(o.is_published, FALSE) AS published,
             ${audience('o.is_published', 'o.shared_groups')} AS audience, NULL::timestamptz AS published_at`,
            'FROM knowledge_bases o LEFT JOIN users u ON u.id = o.tenant_id',
            `${inOrg('o.organization_id')} AND o.system_slug IS NULL`,
        ),
        evidence: null, label: null, peopleKnown: false, itemCost: false,
    },
    {
        kind: 'skill',
        objects: objectsSql(
            `o.id, o.name, o.user_id AS owner, o.created_at, COALESCE(o.is_shared, FALSE) AS published,
             ${audience('o.is_shared', 'o.shared_groups')} AS audience, NULL::timestamptz AS published_at`,
            'FROM skills o LEFT JOIN users u ON u.id = o.user_id',
            inOrg('o.org_id'),
        ),
        // An activation outside the skill's own test tab.
        evidence: (objects) => `SELECT a.skill_id AS object_id, a.user_id AS person, a.at AS ts
            FROM skill_activations a JOIN (${objects}) o ON o.id = a.skill_id WHERE a.source <> 'test'`,
        label: 'activations', peopleKnown: true, itemCost: false,
    },
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
    },
    {
        kind: 'document',
        objects: objectsSql(
            `o.id, o.name, o.user_id AS owner, o.created_at,
             (COALESCE(o.sharing_audience, o.visibility) <> 'private') AS published,
             CASE WHEN o.sharing_audience = 'restricted' THEN 'group'
                  WHEN COALESCE(o.sharing_audience, o.visibility) = 'private' THEN 'private' ELSE 'org' END AS audience,
             NULL::timestamptz AS published_at`,
            'FROM studio_documents o LEFT JOIN users u ON u.id = o.user_id',
            `${inOrg('o.organization_id')} AND NOT o.archived`,
        ),
        evidence: null, label: null, peopleKnown: false, itemCost: false,
    },
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
    },
    {
        kind: 'playbook',
        objects: objectsSql(
            `o.id, o.title AS name, o.user_id AS owner, o.created_at, FALSE AS published,
             'private' AS audience, NULL::timestamptz AS published_at`,
            'FROM playbooks o LEFT JOIN users u ON u.id = o.user_id',
            inOrg('o.organization_id'),
        ),
        evidence: null, label: null, peopleKnown: false, itemCost: false,
    },
    {
        kind: 'solution',
        objects: objectsSql(
            `o.id, o.name, o.owner_id AS owner, o.created_at,
             EXISTS (SELECT 1 FROM project_shares ps WHERE ps.project_id = o.id) AS published,
             CASE WHEN EXISTS (SELECT 1 FROM project_shares ps WHERE ps.project_id = o.id) THEN 'group' ELSE 'private' END AS audience,
             NULL::timestamptz AS published_at`,
            'FROM projects o LEFT JOIN users u ON u.id = o.owner_id',
            `${inOrg('o.organization_id')} AND o.kind = 'solution' AND o.archived_at IS NULL`,
        ),
        evidence: (objects) => `SELECT pa.project_id AS object_id, pa.actor_id AS person, pa.created_at AS ts
            FROM project_activity pa JOIN (${objects}) o ON o.id = pa.project_id`,
        label: 'activities', peopleKnown: true, itemCost: false,
    },
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
    },
];

/** The kind keys, in report order. */
const KIND_KEYS = Object.freeze(KINDS.map((k) => k.kind));

/** @param {string} kind */
function kindDef(kind) {
    return KINDS.find((k) => k.kind === kind) || null;
}

module.exports = { KINDS, KIND_KEYS, kindDef };
