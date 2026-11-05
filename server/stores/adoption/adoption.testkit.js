'use strict';
/**
 * The Adoption read model's test bed: a real Postgres (PGlite behind db.js),
 * every store that owns a table the report reads initialised by its own
 * initDB, and two organisations with members, groups, Studio objects, usage
 * evidence and ledger rows. Org B mirrors org A so a test can prove that
 * nothing of B reaches A.
 *
 * Test-only (`.testkit.js`: neither the server nor the layering scan loads it).
 *
 *   const kit = require('./adoption.testkit');
 *   before(kit.setUp, { timeout: 180_000 });
 *   after(kit.tearDown);
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'adoption-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'adoption-test-master-key-0123456789abcdef01234567';

const { usePglitePool } = require('../../testUtils/pglitePool');

const DAY = 24 * 60 * 60 * 1000;
// The real clock: the routes read the period from it (routes/usageScope.js).
const NOW = Date.now();
const ORG_A = 'org-adopt-a';
const ORG_B = 'org-adopt-b';

/** Stores whose initDB creates the tables the report reads, in a safe order. */
const STORES = [
    'userStore', 'usageStore', 'agentStore', 'datatableStore', 'automationStore', 'studioAppStore', 'studioAppDataStore',
    'skillStore', 'skillActivations', 'webpageStore', 'webpagePublicShareStore', 'transcriptionStore',
    'projectStore', 'coworkStore', 'knowledgeBases', 'documentStore', 'playbookStore',
];

let pool = null;

/** @param {number} daysAgo */
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

/** The people of one organisation: ids prefixed with the org letter. */
function peopleOf(letter, orgId) {
    return [
        { id: `${letter}-owner`, username: `${letter}owner`, displayName: `Owner ${letter.toUpperCase()}`, organizationId: orgId, lastSeen: at(1), createdAt: at(200) },
        { id: `${letter}-colleague`, username: `${letter}colleague`, displayName: `Colleague ${letter.toUpperCase()}`, organizationId: orgId, lastSeen: at(2), createdAt: at(200) },
        { id: `${letter}-seen`, username: `${letter}seen`, displayName: `Seen ${letter.toUpperCase()}`, organizationId: orgId, lastSeen: at(3), createdAt: at(200) },
        { id: `${letter}-dormant`, username: `${letter}dormant`, displayName: `Dormant ${letter.toUpperCase()}`, organizationId: orgId, lastSeen: at(90), createdAt: at(300) },
        { id: `${letter}-new`, username: `${letter}new`, displayName: `New ${letter.toUpperCase()}`, organizationId: orgId, lastSeen: null, createdAt: at(5) },
        { id: `${letter}-pending`, username: `${letter}pending`, displayName: `Pending ${letter.toUpperCase()}`, organizationId: orgId, lastSeen: null, createdAt: at(5), status: 'pending' },
    ];
}

async function initStores() {
    for (const name of STORES) {
        const s = require(`../${name}`);
        if (typeof s.initDB === 'function') await s.initDB();
    }
    // The boot ladder's column on automation_runs (boot/bootMigrations.js), not the store's.
    await require('../../migrations/automation-form-submitter-2026-09').up();
    // The action-run log is created by its own init (studioAppData/schema.js).
    const appData = require('../studioAppData/schema');
    for (const fn of Object.values(appData)) if (typeof fn === 'function' && /^init/.test(fn.name)) await fn();
}

async function seedOrg(letter, orgId) {
    const userStore = require('../userStore');
    const { run } = require('../../db');
    await userStore.createOrganization({ id: orgId, name: `Org ${letter}` }, { autoGrantTrial: false });
    const groupBig = `${letter}-grp-big`;
    const groupSmall = `${letter}-grp-small`;
    await run(`INSERT INTO groups (id, "organizationId", name, source) VALUES ($1, $2, $3, 'local'), ($4, $2, $5, 'nextcloud')`,
        [groupBig, orgId, `Big ${letter}`, groupSmall, `Small ${letter}`]);
    for (const p of peopleOf(letter, orgId)) {
        await userStore.createUser({ id: p.id, username: p.username, displayName: p.displayName, email: `${p.id}@adopt.test`, organizationId: orgId, role: 'user', orgRole: 'member', passwordHash: 'x', groups: [] });
        await run(`UPDATE users SET last_seen_at = $2, "createdAt" = $3, status = $4, groups = $5 WHERE id = $1`,
            [p.id, p.lastSeen, p.createdAt.slice(0, 10), p.status || 'active',
                JSON.stringify(p.id.endsWith('dormant') ? [groupSmall] : [groupBig])]);
    }
    return { groupBig, groupSmall };
}

async function seedObjects(letter, orgId) {
    const { run } = require('../../db');
    const owner = `${letter}-owner`;
    const colleague = `${letter}-colleague`;
    const id = (k) => `${letter}-${k}`;
    await run(`INSERT INTO agents (id, name, owner_id, organization_id, is_published, created_at) VALUES ($1, 'Agent', $2, $3, TRUE, $4), ($5, 'Quiet agent', $2, $3, TRUE, $4)`,
        [id('agent'), owner, orgId, at(10), id('agent2')]);
    await run(`INSERT INTO agent_conversations (id, agent_id, user_id, updated_at) VALUES ($1, $2, $3, $4)`, [id('conv'), id('agent'), colleague, at(3)]);
    await run(`INSERT INTO automations (id, user_id, organization_id, title, definition_json, created_at) VALUES ($1, $2, NULL, 'Flow', '{}'::jsonb, $3)`,
        [id('auto'), owner, at(100)]);
    // A run started by the colleague: it counts for the colleague, not the owner.
    await run(`INSERT INTO automation_runs (id, automation_id, version, user_id, started_by_user_id, trigger_kind, started_at) VALUES ($1, $2, 1, $3, $4, 'manual', $5)`,
        [id('run'), id('auto'), owner, colleague, at(4)]);
    await run(`INSERT INTO studio_apps (id, user_id, organization_id, name, is_published, created_at) VALUES ($1, $2, $3, 'App', TRUE, $4)`,
        [id('app'), owner, orgId, at(20)]);
    await run(`INSERT INTO studio_app_action_runs (id, app_id, owner_user_id, action_id, origin, viewer_user_id, started_at) VALUES ($1, $2, $3, 'go', 'click', $4, $5)`,
        [id('apprun'), id('app'), owner, colleague, at(2)]);
    await run(`INSERT INTO skills (id, org_id, user_id, name, is_shared, created_at) VALUES ($1, $2, $3, 'Skill', TRUE, $4)`, [id('skill'), orgId, owner, at(50)]);
    await run(`INSERT INTO skill_activations (skill_id, user_id, source, at) VALUES ($1, $2, 'static', $3)`, [id('skill'), colleague, at(6)]);
    await run(`INSERT INTO transcriptions (id, user_id, organization_id, title, created_at) VALUES ($1, $2, $3, 'Standup', $4)`, [id('meet'), colleague, orgId, at(7)]);
    await run(`INSERT INTO datatables (id, scope_id, organization_id, owner_user_id, key, name, created_at) VALUES ($1, $2, $2, $3, $1, 'Table', $4)`, [id('table'), orgId, owner, at(40)]);
}

async function seedLedger(letter, orgId) {
    const { run } = require('../../db');
    const rows = [
        // [user_id, actor_user_id, source, agent_id, cost, daysAgo]
        [`${letter}-owner`, null, 'agent_stream', `${letter}-agent`, 1.0, 3],
        [`${letter}-owner`, `${letter}-colleague`, 'studio_app_action', `${letter}-app`, 2.0, 2],
        [`${letter}-owner`, `${letter}-colleague`, 'automation', `${letter}-auto`, 0.5, 4],
        [`${letter}-owner`, null, 'direct_chat', null, 0.25, 40],
        [`guest_x${letter}`, null, 'studio_app_public', `${letter}-app`, 9, 2],
        [`${letter}-owner`, null, 'some_new_source', null, 0.1, 1],
    ];
    for (const [userId, actor, source, agentId, cost, daysAgo] of rows) {
        await run(`INSERT INTO ai_usage_log (timestamp, user_id, actor_user_id, agent_id, model, source, organization_id, estimated_cost)
                   VALUES ($1, $2, $3, $4, 'test-model', $5, $6, $7)`, [at(daysAgo), userId, actor, agentId, source, orgId, cost]);
    }
    // A tool row: never counted as a call.
    await run(`INSERT INTO ai_usage_log (timestamp, user_id, model, source, organization_id, estimated_cost, tool_name) VALUES ($1, $2, 'm', 'agent_stream', $3, 0, 'search')`,
        [at(3), `${letter}-seen`, orgId]);
}

async function setUp() {
    pool = usePglitePool();
    await initStores();
    for (const [letter, orgId] of [['a', ORG_A], ['b', ORG_B]]) {
        await seedOrg(letter, orgId);
        await seedObjects(letter, orgId);
        await seedLedger(letter, orgId);
    }
    // Creating an organisation finishes some work in the background
    // (stores/user/organizations.js); let it reach PGlite, not the real pool after tearDown.
    await new Promise((resolve) => setTimeout(resolve, 300));
}

async function tearDown() {
    if (pool) await pool.close();
}

/** A scope over the last 30 days of NOW. */
function scope(orgId = ORG_A, extra = {}) {
    return {
        orgId,
        period: { startDate: at(30), endDate: new Date(NOW).toISOString(), days: 30, relative: true },
        now: NOW,
        groupId: null,
        ...extra,
    };
}

/** The store under test, with the licence seat cap answered locally. */
function store() {
    const { createAdoptionStore } = require('../adoptionStore');
    return createAdoptionStore({ seats: { getMaxSeatsForOrg: async () => 25 } });
}

module.exports = { setUp, tearDown, scope, store, at, NOW, DAY, ORG_A, ORG_B, STORES };
