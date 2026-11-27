// @typecheck strict
/**
 * The Studio kinds of the Adoption report, organisation-wide: for each kind,
 * the SQL of its objects and, where one exists, the SQL of its usage evidence
 * (the shape of a kind: ./kindSql.js).
 *
 * routes/studio/counts.js counts per CALLER, through the list functions of
 * each kind, on purpose. This table is the organisation's view instead, and
 * reads every table directly.
 *
 * The core declares its own kinds here. A kind whose tables a first-party
 * module creates is declared by that module (stores/adoption/kinds.<module>.js)
 * and asked for by name at the point of use: a module that is not part of this
 * installation leaves its kinds out of the report (no row, no key), it does not
 * report zero. KIND_KEYS is the report's vocabulary (the API names every kind
 * it knows); kindKeys() the kinds of this installation.
 *
 * Kinds without a usage signal (datatables, knowledge bases, documents,
 * playbooks) have no evidence: the report says "no signal" rather than
 * inventing one, and nothing here records views (docs/docs/reference/telemetry.md).
 */

'use strict';

const { inOrg, audience, objectsSql } = require('./kindSql');

/** @typedef {import('./kindSql').KindDef} KindDef */

/** @type {KindDef} */
const AGENT = {
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
};

/** @type {KindDef} */
const KB = {
    kind: 'kb',
    objects: objectsSql(
        `o.id::text AS id, o.name, o.tenant_id AS owner, o.created_at, COALESCE(o.is_published, FALSE) AS published,
         ${audience('o.is_published', 'o.shared_groups')} AS audience, NULL::timestamptz AS published_at`,
        'FROM knowledge_bases o LEFT JOIN users u ON u.id = o.tenant_id',
        `${inOrg('o.organization_id')} AND o.system_slug IS NULL`,
    ),
    evidence: null, label: null, peopleKnown: false, itemCost: false,
};

/** @type {KindDef} */
const SKILL = {
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
};

/** @type {KindDef} */
const DOCUMENT = {
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
};

/** @type {KindDef} */
const SOLUTION = {
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
};

/**
 * Where each kind comes from, in report order: a kind of the core, or the name of the module
 * part that declares a module's kinds (registered by that module, see its provides file).
 */
const SOURCES = /** @type {const} */ ([
    AGENT,
    'stores/adoption/kinds.automation',
    'stores/adoption/kinds.apps',
    'stores/adoption/kinds.datatables',
    KB,
    SKILL,
    'stores/adoption/kinds.webpages',
    DOCUMENT,
    'stores/adoption/kinds.meetingNotes',
    'stores/adoption/kinds.playbooks',
    SOLUTION,
    'stores/adoption/kinds.cowork',
]);

/**
 * Every kind the report knows, in report order: the API's vocabulary for `?kind=`, whether or
 * not the module of a kind is part of this installation (kindKeys() says which are).
 */
const KIND_KEYS = Object.freeze(['agent', 'automation', 'form', 'app', 'datatable', 'kb', 'skill', 'webpage', 'document', 'meeting', 'playbook', 'solution', 'cowork']);

/**
 * The kinds of this installation, in report order. Asked at the point of use: the module parts
 * are looked up by name, and an absent module's kinds are left out.
 * @returns {KindDef[]}
 */
function kinds() {
    const { lookupFeatureModule } = require('../../modules/firstParty/moduleData');
    return SOURCES.flatMap((source) => (typeof source === 'string' ? (lookupFeatureModule(source)?.KINDS ?? []) : [source]));
}

/** The kind keys of this installation, in report order. */
function kindKeys() {
    return kinds().map((k) => k.kind);
}

/**
 * A kind of this installation, or null (a kind the report does not know, or one whose module
 * is not here).
 * @param {string} kind
 */
function kindDef(kind) {
    return kinds().find((k) => k.kind === kind) || null;
}

module.exports = { KIND_KEYS, kinds, kindKeys, kindDef };
