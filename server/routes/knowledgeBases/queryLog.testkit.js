'use strict';

/**
 * The world of the KB query-log route tests (queryLog*.test.js): the real router, the real stores and
 * a real Postgres (PGlite), three organisations (two licensed, one not), five people and two
 * published bases. A test file calls `useQueryLogWorld()` once, at the top; `world` is filled by its
 * `before` hook (api, kbId, freeKbId, store).
 */

const { before, after, beforeEach } = require('node:test');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'qlog-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'qlog-test-master-key-0123456789abcdef0123456789';

const { usePglitePool } = require('../../testUtils/pglitePool');
const { pg, close: closePg } = usePglitePool();
const h = require('../../testUtils/routeHarness');
const crypto = require('../../stores/kb/queryLog/crypto.mts');

const ORG = 'org-ql';           // licensed (enterprise plan)
const ORG_OTHER = 'org-ql-2';   // licensed, another tenant
const ORG_FREE = 'org-ql-free'; // no kb_query_log
const mk = (id, org, extra = {}) => ({ id, username: id, email: `${id}@ql.test`, organizationId: org, role: 'user', orgRole: 'member', groups: [], ...extra });
const OWNER = mk('u-owner', ORG);
const READER = mk('u-reader', ORG);
const OUTSIDER = mk('u-outsider', ORG_OTHER);
const FREE_OWNER = mk('u-free-owner', ORG_FREE);
const ASKER = mk('u-asker', ORG, { displayName: 'Ada Asker' });

/** @type {{ api: any, kbId: string, freeKbId: string, store: any }} */
const world = { api: null, kbId: '', freeKbId: '', store: null };

/**
 * Register the hooks that build the world, reset the log before each test and close it after.
 * @param {(w: typeof world) => void} [onReady] called once the world is built
 */
function useQueryLogWorld(onReady) {
    before(async () => {
        crypto._setCryptoDeps({ getOrgRootKey: async () => Buffer.alloc(32, 7), sealingEnabled: async () => true });
        const userStore = require('../../stores/userStore');
        await userStore.initDB();
        const enterprise = await userStore.createPlan({ name: 'QL enterprise', tier: 'enterprise', allowed_features: ['knowledge', 'kb_query_log'] });
        const pro = await userStore.createPlan({ name: 'QL free', tier: null, allowed_features: ['knowledge'] });
        for (const [id, plan] of [[ORG, enterprise], [ORG_OTHER, enterprise], [ORG_FREE, pro]]) {
            await userStore.createOrganization({ id, name: id }, { autoGrantTrial: false });
            await userStore.setOrgSubscription(id, { plan_id: plan.id, status: 'active' });
        }
        for (const u of [OWNER, READER, OUTSIDER, FREE_OWNER, ASKER]) await userStore.createUser({ ...u, passwordHash: 'x' });
        const kbStore = require('../../stores/knowledgeBases');
        world.kbId = (await kbStore.createKB(OWNER.id, 'Handbook', '', ORG, { isPublished: true })).id;
        world.freeKbId = (await kbStore.createKB(FREE_OWNER.id, 'Free handbook', '', ORG_FREE, { isPublished: true })).id;
        world.store = require('../../stores/kb/queryLog/index.mts');
        world.api = h.serve('/', require('../knowledgeBases'), { user: OWNER });
        if (onReady) onReady(world);
    }, { timeout: 120_000 });

    after(async () => {
        crypto._setCryptoDeps(null);
        await world.api.close();
        await closePg();
    });

    beforeEach(async () => {
        await pg.exec('DELETE FROM kb_query_log; DELETE FROM kb_query_log_ack; DELETE FROM access_audit_log');
        await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = false, query_log_retention_days = 90, query_log_show_names = false,
            query_log_ai_act_high_risk = false, query_log_attestation = NULL, query_log_attested_by = NULL, query_log_attested_at = NULL, query_log_changed_at = NULL`);
    });
    return world;
}

const audit = async () => (await pg.query('SELECT action, target_type, target_id, changed_by, organization_id, old_values, new_values FROM access_audit_log ORDER BY created_at, id')).rows;
const as = (user) => ({ user });
const put = (body, user = OWNER, id = world.kbId) => world.api.call('PUT', `/${id}/query-log/settings`, { user, body });
const enabledNow = async (id = world.kbId) => (await pg.query('SELECT query_log_enabled FROM knowledge_bases WHERE id = $1', [id])).rows[0].query_log_enabled;

module.exports = {
    useQueryLogWorld, world, pg, h, audit, as, put, enabledNow,
    ORG, ORG_OTHER, ORG_FREE, OWNER, READER, OUTSIDER, FREE_OWNER, ASKER,
};
